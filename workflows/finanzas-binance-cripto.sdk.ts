// Fuente SDK de "Finanzas - Saldos cripto Binance (Spot + Earn)".
// Se recrea con la herramienta create_workflow_from_code del MCP n8n-cloud.
// Credenciales que carga el usuario en n8n (nunca en este archivo):
//   - "Binance API Key" (Header Auth): Name X-MBX-APIKEY, Value = API Key de solo lectura.
//   - "Binance Secret" (Crypto): HMAC secret = Secret Key de esa API.
import { workflow, node, trigger, sticky, newCredential, expr } from '@n8n/workflow-sdk';

const SHEET_ID = 'TU_GOOGLE_SHEET_ID';
const sheetsCred = { googleSheetsOAuth2Api: { id: 'TU_CREDENCIAL_SHEETS', name: 'Google Sheets' } };
const telegramCred = { telegramApi: { id: 'TU_CREDENCIAL_TELEGRAM', name: 'Telegram account' } };

const consultasCode = `// Una consulta firmada por cada billetera: Spot, Earn flexible y Earn bloqueado.
const ts = Date.now();
const base = 'recvWindow=10000&timestamp=' + ts;
return [
  { json: { billetera: 'spot', endpoint: '/api/v3/account', query: 'omitZeroBalances=true&' + base } },
  { json: { billetera: 'earn_flexible', endpoint: '/sapi/v1/simple-earn/flexible/position', query: 'size=100&' + base } },
  { json: { billetera: 'earn_bloqueado', endpoint: '/sapi/v1/simple-earn/locked/position', query: 'size=100&' + base } },
];`;

const calcularCode = `// Junta Spot + Earn por activo, lo valúa en USD y arma las filas de la hoja Cripto.
// Si alguna de las 3 consultas falló, se corta acá y la hoja queda con el último dato bueno.
const respuestas = $('Consultar Binance').all().map((it) => it.json);
if (respuestas.length !== 3) throw new Error('Binance respondió ' + respuestas.length + ' de 3 consultas; no se actualiza la hoja.');
const precios = {};
for (const it of $('Precios Binance').all()) {
  if (it.json && it.json.symbol) precios[it.json.symbol] = Number(it.json.price);
}

const spot = {}, earn = {};
const sumar = (obj, activo, cant) => { cant = Number(cant) || 0; if (cant > 0) obj[activo] = (obj[activo] || 0) + cant; };

for (const r of respuestas) {
  if (Array.isArray(r.balances)) {
    for (const b of r.balances) sumar(spot, b.asset, Number(b.free) + Number(b.locked));
  } else {
    // Earn flexible trae totalAmount; Earn bloqueado trae amount.
    for (const p of r.rows || []) sumar(earn, p.asset, p.totalAmount !== undefined ? p.totalAmount : p.amount);
  }
}
// En Spot, Earn flexible aparece como "LD" + activo (LDBTC, LDUSDT, a veces con número: LDSHIB2): ya se cuenta en Earn.
// Solo se descarta si existe el activo base en Earn, para no perder tokens reales como LDO.
for (const a of Object.keys(spot)) {
  if (!a.startsWith('LD')) continue;
  const base = a.slice(2);
  if (earn[base] !== undefined || earn[base.replace(/\\d+$/, '')] !== undefined) delete spot[a];
}

const ESTABLES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'DAI'];
const precioUsd = (a) => {
  if (ESTABLES.includes(a)) return 1;
  for (const q of ['USDT', 'FDUSD', 'USDC']) if (precios[a + q]) return precios[a + q];
  if (precios[a + 'BTC'] && precios.BTCUSDT) return precios[a + 'BTC'] * precios.BTCUSDT;
  return null;
};

const ahora = $now.setZone('America/Argentina/Cordoba').toFormat('dd-MM-yyyy HH:mm');
const activos = [...new Set([...Object.keys(spot), ...Object.keys(earn)])];
const filas = activos.map((a) => {
  const s = spot[a] || 0, e = earn[a] || 0, cant = s + e;
  const p = precioUsd(a);
  return { a, s, e, cant, p, usd: p == null ? null : cant * p };
})
  .filter((f) => f.usd == null || f.usd >= 1)   // oculta polvo de menos de US$ 1
  .sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1));

// Texto con punto decimal: la hoja no lo reinterpreta según el idioma.
const t = (n, d) => (n == null ? '' : String(Number(n.toFixed(d))));
return filas.map((f) => ({
  json: {
    Activo: f.a,
    Spot: t(f.s, 8),
    Earn: t(f.e, 8),
    Cantidad: t(f.cant, 8),
    'Precio USD': t(f.p, 8),
    'Total USD': t(f.usd, 2),
    Actualizado: ahora,
  },
}));`;

const cada = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Cada hora',
    position: [0, 300],
    parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1, triggerAtMinute: 5 }] } }
  }
});

const consultas = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Armar consultas',
    position: [220, 300],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: consultasCode }
  }
});

const firmar = node({
  type: 'n8n-nodes-base.crypto',
  version: 2,
  config: {
    name: 'Firmar consulta (HMAC)',
    position: [440, 300],
    parameters: {
      action: 'hmac',
      type: 'SHA256',
      value: expr('{{ $json.query }}'),
      dataPropertyName: 'firma',
      encoding: 'hex'
    },
    credentials: { crypto: newCredential('Binance Secret') }
  }
});

const consultar = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Consultar Binance',
    position: [660, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
    parameters: {
      method: 'GET',
      url: expr('https://api.binance.com{{ $json.endpoint }}?{{ $json.query }}&signature={{ $json.firma }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: { timeout: 15000, batching: { batch: { batchSize: 1, batchInterval: 300 } } }
    },
    credentials: { httpHeaderAuth: newCredential('Binance API Key') }
  }
});

const preciosNode = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Precios Binance',
    position: [880, 280],
    executeOnce: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
    parameters: {
      method: 'GET',
      url: 'https://api.binance.com/api/v3/ticker/price',
      authentication: 'none',
      options: { timeout: 15000 }
    }
  }
});

const calcular = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Calcular saldos en USD',
    position: [1100, 280],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: calcularCode }
  }
});

const limpiar = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Vaciar hoja Cripto',
    position: [1320, 280],
    executeOnce: true,
    parameters: {
      resource: 'sheet',
      operation: 'clear',
      authentication: 'oAuth2',
      documentId: { __rl: true, mode: 'id', value: SHEET_ID },
      sheetName: { __rl: true, mode: 'name', value: 'Cripto' },
      clear: 'wholeSheet',
      keepFirstRow: true
    },
    credentials: sheetsCred
  }
});

const filasNode = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Filas a escribir',
    position: [1540, 280],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: "// Vuelve a tomar las filas calculadas (Vaciar hoja devuelve un solo ítem).\nreturn $('Calcular saldos en USD').all();" }
  }
});

const colSchema = [
  { id: 'Activo', displayName: 'Activo', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'Spot', displayName: 'Spot', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'Earn', displayName: 'Earn', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'Cantidad', displayName: 'Cantidad', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'Precio USD', displayName: 'Precio USD', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'Total USD', displayName: 'Total USD', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' },
  { id: 'Actualizado', displayName: 'Actualizado', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }
];

const escribir = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Escribir hoja Cripto',
    position: [1760, 280],
    parameters: {
      resource: 'sheet',
      operation: 'append',
      authentication: 'oAuth2',
      documentId: { __rl: true, mode: 'id', value: SHEET_ID },
      sheetName: { __rl: true, mode: 'name', value: 'Cripto' },
      columns: { mappingMode: 'autoMapInputData', value: {}, schema: colSchema },
      options: { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' }
    },
    credentials: sheetsCred
  }
});

const avisar = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar error Binance',
    position: [1100, 520],
    executeOnce: true,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: 'TU_CHAT_ID_TELEGRAM',
      text: expr('⚠️ No pude actualizar tus saldos de Binance: {{ $json.error && ($json.error.message || $json.error) }}. El dashboard sigue mostrando el último dato.'),
      replyMarkup: 'none',
      additionalFields: { appendAttribution: false }
    },
    credentials: telegramCred
  }
});

const notas = sticky(
  '## Saldos cripto Binance\n\nCada hora: firma las consultas con tu Secret (credencial **Binance Secret**), lee **Spot + Earn** con la API Key de solo lectura (**Binance API Key**), valúa todo en USD y reescribe la hoja **Cripto** de Control de Finanzas.\n\nSi Binance falla, no toca la hoja y avisa por Telegram.',
  [cada, consultas, firmar, consultar],
  { color: 6 }
);

export default workflow('finanzas-binance', 'Finanzas - Saldos cripto Binance (Spot + Earn)')
  .add(cada)
  .to(consultas)
  .to(firmar)
  .to(consultar)
  .to(preciosNode)
  .to(calcular)
  .to(limpiar)
  .to(filasNode)
  .to(escribir)
  .add(consultar.onError(avisar))
  .add(preciosNode.onError(avisar))
  .add(notas);
