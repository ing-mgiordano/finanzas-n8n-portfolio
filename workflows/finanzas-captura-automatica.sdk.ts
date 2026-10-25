// Fuente SDK de "Finanzas - Captura automática (Mails + Apple Pay)".
// Se recrea con la herramienta create_workflow_from_code del MCP n8n-cloud.
import { workflow, node, trigger, sticky, newCredential, ifElse, expr } from '@n8n/workflow-sdk';

const telegramCred = { telegramApi: { id: 'TU_CREDENCIAL_TELEGRAM', name: 'Telegram account' } };

const prepMailCode = `// Convierte cada mail de banco/billetera en un texto limpio para Claude.
const salida = [];
for (const item of $input.all()) {
  const j = item.json;
  const remitente = String((j.from && (j.from.text || (j.from.value && j.from.value[0] && j.from.value[0].address))) || '');
  const r = remitente.toLowerCase();
  const fuente = r.includes('mercadopago') ? 'Mercado Pago'
    : r.includes('revolut') ? 'Revolut'
    : r.includes('santander') ? 'Santander'
    : r.includes('supervielle') ? 'Supervielle'
    : 'Otro';

  const cuerpo = String(j.text || j.snippet || '')
    .replace(/https?:\\/\\/\\S+/g, '')
    .replace(/\\[\\]\\([^)]*\\)/g, '')
    .replace(/[|#*_>]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 2500);

  const fecha = (j.date ? DateTime.fromJSDate(new Date(j.date)) : $now)
    .setZone('America/Argentina/Cordoba').toFormat('dd-MM-yyyy');

  salida.push({
    json: {
      texto: 'Aviso por mail de ' + fuente + '\\nAsunto: ' + (j.subject || '') + '\\nFecha del aviso: ' + fecha + '\\n\\n' + cuerpo,
      fecha_hoy: fecha,
      origen: 'Mail ' + fuente,
      referencia: j.subject || '',
      chat_id: 'TU_CHAT_ID_TELEGRAM',
    },
  });
}
return salida;`;

const prepApplePayCode = `// Arma el texto para Claude con lo que manda la automatización de Atajos (iPhone).
// Body esperado: { "monto": "€12,50", "comercio": "Mercadona", "tarjeta": "Revolut" }
const fecha = $now.setZone('America/Argentina/Cordoba').toFormat('dd-MM-yyyy');
return $input.all().map(item => {
  const b = item.json.body || {};
  const tarjeta = String(b.tarjeta || '').trim();
  return {
    json: {
      texto: 'Pago con Apple Pay\\nMonto: ' + String(b.monto || '').trim() + '\\nComercio: ' + String(b.comercio || '').trim() + '\\nTarjeta: ' + tarjeta + '\\nFecha: ' + fecha,
      fecha_hoy: fecha,
      origen: 'Apple Pay' + (tarjeta ? ' ' + tarjeta : ''),
      referencia: String(b.comercio || ''),
      chat_id: 'TU_CHAT_ID_TELEGRAM',
    },
  };
});`;

const parseCode = `// Limpia la respuesta de Claude (bloques markdown, texto extra) y la parsea de forma segura.
// Si algo no cierra, marca el aviso como INVALIDO y no se registra nada.
const origen = $('Unificar entrada').item.json;
const r = $json;

let crudo = '';
if (typeof r.merged_response === 'string') crudo = r.merged_response;
else if (Array.isArray(r.content)) crudo = r.content.filter(c => c && c.type === 'text').map(c => c.text).join('\\n');
else if (typeof r.text === 'string') crudo = r.text;
else if (typeof r.output === 'string') crudo = r.output;

let limpio = String(crudo).replace(/\`\`\`(?:json)?/gi, '').trim();
const ini = limpio.indexOf('{');
const fin = limpio.lastIndexOf('}');
if (ini !== -1 && fin > ini) limpio = limpio.slice(ini, fin + 1);

let d = {};
let errorParseo = '';
try {
  d = JSON.parse(limpio);
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('La respuesta no es un objeto JSON');
} catch (e) {
  d = {};
  errorParseo = e.message;
}

const CATEGORIAS = [
  'Alimentación / Supermercado', 'Salidas / Ocio', 'Servicios y Suscripciones', 'Salud y Deporte',
  'Farmacia', 'Transporte / Vehículo', 'Indumentaria / Compras', 'Vivienda / Hogar', 'Educación / Cursos',
  'Donaciones', 'Ingresos / Sueldo / Extras', 'Otros',
];
// Por si Claude devuelve la categoría con la aclaración entre paréntesis
const categoriaCruda = String(d.categoria || '').replace(/\s*\(.*\)\s*$/, '').trim();

const tipoCrudo = String(d.tipo || '').toUpperCase().trim();
let tipo = ['GASTO', 'INGRESO'].includes(tipoCrudo) ? tipoCrudo : 'INVALIDO';

let monto = d.monto;
if (typeof monto === 'string') {
  monto = monto.replace(/[^\\d,.-]/g, '').replace(/\\.(?=\\d{3}(\\D|$))/g, '').replace(',', '.');
}
monto = Number(monto);
if (tipo !== 'INVALIDO' && !(Number.isFinite(monto) && monto > 0)) tipo = 'INVALIDO';
monto = tipo === 'INVALIDO' ? 0 : Math.round(monto * 100) / 100;

const monedaCruda = String(d.moneda || '').toUpperCase();
const moneda = monedaCruda.includes('EUR') || monedaCruda.includes('€') ? 'EUR'
  : monedaCruda.includes('USD') ? 'USD' : 'ARS';
const fecha = /^\\d{2}-\\d{2}-\\d{4}$/.test(String(d.fecha || '')) ? d.fecha : origen.fecha_hoy;

return {
  json: {
    fecha,
    tipo,
    monto,
    moneda,
    categoria: CATEGORIAS.includes(categoriaCruda) ? categoriaCruda : 'Otros',
    descripcion: String(d.descripcion || '').trim(),
    metodo_pago: String(d.metodo_pago || '').trim() || 'No especificado',
    notas: String(d.notas || '').trim(),
    origen: origen.origen,
    chat_id: origen.chat_id,
    referencia: origen.referencia,
    error_parseo: errorParseo,
    respuesta_cruda: crudo,
  },
};`;

const systemPrompt = `Eres un asistente experto en finanzas personales. Recibes el texto de un aviso automático de un banco o billetera virtual (un mail o un pago con Apple Pay) y debes devolver un objeto JSON estricto con el movimiento.

FECHA DEL AVISO (Sistema): {{ $json.fecha_hoy }}

CATEGORÍAS PERMITIDAS (selecciona la más adecuada):
- Alimentación / Supermercado
- Salidas / Ocio
- Servicios y Suscripciones
- Salud y Deporte (médicos, prepaga, estudios, gimnasio, deportes)
- Farmacia (medicamentos y compras en farmacia)
- Transporte / Vehículo
- Indumentaria / Compras
- Vivienda / Hogar
- Educación / Cursos
- Donaciones (donaciones, caridad, colectas, aportes a ONG)
- Ingresos / Sueldo / Extras
- Otros

MÉTODO DE PAGO: indica el medio y la entidad, por ejemplo: 'Mercado Pago', 'Tarjeta de Crédito Santander', 'Tarjeta de Débito Revolut', 'Transferencia Revolut', 'Tarjeta de Crédito Supervielle'.

REGLAS DE PROCESAMIENTO:
1. Moneda: €, EUR o euros → 'EUR'; US$, USD o dólares → 'USD'; $ o pesos → 'ARS'. Si no hay símbolo y la entidad es Revolut o Santander España, usa 'EUR'; si es Mercado Pago o Supervielle, usa 'ARS'.
2. Pagos, compras, débitos y transferencias enviadas a terceros → 'GASTO'. Dinero recibido (transferencia recibida, cobro, reintegro, sueldo) → 'INGRESO'.
3. Usa "INVALIDO" si el aviso NO es un movimiento concreto y confirmado: publicidad, promociones, códigos de verificación, extractos o resúmenes, avisos de seguridad, pagos rechazados o pendientes, y transferencias entre cuentas propias del mismo titular.
4. descripcion: el comercio o destinatario de forma breve (ej. 'Coto', 'Netflix', 'Transferencia a Juan Pérez').
5. Si el aviso menciona cuotas, colócalo en 'notas'.
6. Usa la fecha del aviso, salvo que el texto indique explícitamente otra fecha de operación.
7. El campo 'categoria' lleva solo el nombre de la categoría, sin lo que está entre paréntesis.
8. Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni bloques markdown.

FORMATO DE SALIDA (JSON exacto):
{
  "fecha": "DD-MM-YYYY",
  "tipo": "GASTO" | "INGRESO" | "INVALIDO",
  "monto": number,
  "moneda": "ARS" | "USD" | "EUR",
  "categoria": "string",
  "descripcion": "string",
  "metodo_pago": "string",
  "notas": "string"
}`;

const gmailTrigger = trigger({
  type: 'n8n-nodes-base.gmailTrigger',
  version: 1.4,
  config: {
    name: 'Mails de bancos',
    position: [0, 200],
    parameters: {
      pollTimes: { item: [{ mode: 'everyX', value: 6, unit: 'hours' }] },
      authentication: 'oAuth2',
      event: 'messageReceived',
      simple: false,
      maxResults: 50,
      filters: {
        q: 'from:(mercadopago OR revolut OR santander OR supervielle) -subject:(código OR codigo OR clave OR extracto OR resumen)',
        readStatus: 'both',
        includeSpamTrash: false,
        includeDrafts: false
      },
      options: { downloadAttachments: false }
    },
    credentials: { gmailOAuth2: newCredential('Gmail') }
  }
});

const applePayHook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.2,
  config: {
    name: 'Apple Pay (Atajos)',
    position: [0, 420],
    parameters: {
      httpMethod: 'POST',
      path: 'finanzas-applepay',
      authentication: 'headerAuth',
      responseMode: 'onReceived',
      options: { responseData: 'OK' }
    },
    credentials: { httpHeaderAuth: newCredential('Apple Pay Webhook') }
  }
});

const prepMail = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Preparar mail',
    position: [220, 200],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: prepMailCode }
  }
});

const prepApplePay = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Preparar Apple Pay',
    position: [220, 420],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: prepApplePayCode }
  }
});

const unify = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Unificar entrada',
    position: [440, 300],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: '// Punto común para mails y Apple Pay: el parser lee el origen desde acá.\nreturn $input.all();' }
  }
});

const claude = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Claude - Interpretar aviso',
    position: [660, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueErrorOutput',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'id', value: 'claude-haiku-5-5' },
      messages: { values: [{ role: 'user', content: expr('{{ $json.texto }}') }] },
      simplify: true,
      options: { system: expr(systemPrompt), includeMergedResponse: true, maxTokens: 500 }
    },
    credentials: { anthropicApi: newCredential('Anthropic') }
  }
});

const parseJson = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Limpiar y parsear JSON',
    position: [880, 280],
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: parseCode }
  }
});

const isMovement = ifElse({
  version: 2.3,
  config: {
    name: '¿Es un movimiento?',
    position: [1100, 280],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          { leftValue: expr('{{ $json.tipo }}'), rightValue: 'GASTO', operator: { type: 'string', operation: 'equals' } },
          { leftValue: expr('{{ $json.tipo }}'), rightValue: 'INGRESO', operator: { type: 'string', operation: 'equals' } }
        ],
        combinator: 'or'
      }
    }
  }
});

const inputSchema = [
  { id: 'fecha', displayName: 'fecha', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'tipo', displayName: 'tipo', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'monto', displayName: 'monto', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' },
  { id: 'moneda', displayName: 'moneda', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'categoria', displayName: 'categoria', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'descripcion', displayName: 'descripcion', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'metodo_pago', displayName: 'metodo_pago', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'notas', displayName: 'notas', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'origen', displayName: 'origen', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'chat_id', displayName: 'chat_id', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
];

const register = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.4,
  config: {
    name: 'Registrar movimiento',
    position: [1340, 260],
    parameters: {
      mode: 'each',
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'TU_ID_SUBWORKFLOW_REGISTRAR', cachedResultName: 'Finanzas - Registrar movimiento (sub-workflow)' },
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          fecha: expr('{{ $json.fecha }}'),
          tipo: expr('{{ $json.tipo }}'),
          monto: expr('{{ $json.monto }}'),
          moneda: expr('{{ $json.moneda }}'),
          categoria: expr('{{ $json.categoria }}'),
          descripcion: expr('{{ $json.descripcion }}'),
          metodo_pago: expr('{{ $json.metodo_pago }}'),
          notas: expr('{{ $json.notas }}'),
          origen: expr('{{ $json.origen }}'),
          chat_id: expr('{{ $json.chat_id }}')
        },
        matchingColumns: [],
        schema: inputSchema,
        attemptToConvertTypes: false
      },
      options: { waitForSubWorkflow: false }
    }
  }
});

const notifyError = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar error de lectura',
    position: [880, 480],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: 'TU_CHAT_ID_TELEGRAM',
      text: expr('❌ No pude interpretar un aviso ({{ $("Unificar entrada").item.json.origen }}): {{ $("Unificar entrada").item.json.referencia }}. Si era un gasto, cargalo a mano en el bot.'),
      replyMarkup: 'none',
      additionalFields: { appendAttribution: false }
    },
    credentials: telegramCred
  }
});

const notes = sticky(
  '## Captura automática de gastos\n\n**Mails** (Mercado Pago, Revolut, Santander, Supervielle) cada 6 horas + **Apple Pay** desde Atajos del iPhone → Claude interpreta → *Registrar movimiento* (chequea duplicados y avisa por Telegram).\n\nPromociones, códigos y extractos se ignoran en silencio.',
  [gmailTrigger, applePayHook, prepMail, prepApplePay],
  { color: 6 }
);

export default workflow('finanzas-captura', 'Finanzas - Captura automática (Mails + Apple Pay)')
  .add(gmailTrigger)
  .to(prepMail)
  .to(unify)
  .add(applePayHook)
  .to(prepApplePay)
  .to(unify)
  .add(unify)
  .to(claude)
  .to(parseJson)
  .to(isMovement.onTrue(register))
  .add(claude.onError(notifyError))
  .add(notes);
