import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

const doc = { __rl: true, mode: 'id', value: 'TU_GOOGLE_SHEET_ID', cachedResultName: 'Control de Finanzas' };
const tab = { __rl: true, mode: 'name', value: 'Transacciones' };
const sheetsCred = { googleSheetsOAuth2Api: { id: 'TU_CREDENCIAL_SHEETS', name: 'Google Sheets' } };
const telegramCred = { telegramApi: { id: 'TU_CREDENCIAL_TELEGRAM', name: 'Telegram account' } };

const colSchema = [
  { id: 'Fecha', displayName: 'Fecha', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Tipo', displayName: 'Tipo', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Monto', displayName: 'Monto', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true },
  { id: 'Moneda', displayName: 'Moneda', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Categoría', displayName: 'Categoría', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Descripción', displayName: 'Descripción', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Método de Pago', displayName: 'Método de Pago', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Notas', displayName: 'Notas', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }
];

const dupCode = `// Busca en la hoja movimientos parecidos al nuevo y arma los textos para Telegram.
// Posible duplicado = mismo monto y moneda, y además fecha a ±1 día o mismo comercio.
const mov = $('Recibir movimiento').first().json;
const filas = $input.all().map(i => i.json).filter(f => f && f.Monto !== undefined && f.Monto !== '');

const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
const IGNORAR = ['compra', 'pago', 'pague', 'gaste', 'gasto', 'con', 'del', 'las', 'los', 'por', 'para', 'una', 'uno'];
const palabras = s => normalizar(s).split(/[^a-z0-9]+/).filter(p => p.length >= 3 && !IGNORAR.includes(p));
const aDia = f => {
  const m = String(f || '').match(/^(\\d{2})-(\\d{2})-(\\d{4})$/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000 : null;
};

const montoNuevo = Number(mov.monto);
const diaNuevo = aDia(mov.fecha);
const palabrasNuevas = palabras(mov.descripcion);

const duplicados = filas.filter(f => {
  if (Number(f.Monto) !== montoNuevo) return false;
  if (String(f.Moneda || '').toUpperCase() !== String(mov.moneda).toUpperCase()) return false;
  const dia = aDia(f.Fecha);
  const fechaCercana = dia !== null && diaNuevo !== null && Math.abs(dia - diaNuevo) <= 1;
  const otras = palabras(f['Descripción']);
  const mismoComercio = palabrasNuevas.some(p => otras.includes(p));
  return fechaCercana || mismoComercio;
});

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = n => {
  try { return Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }); } catch (e) { return String(n); }
};

const esManual = mov.origen === 'Bot';
const notas = [mov.notas, esManual ? '' : 'Auto - ' + mov.origen].filter(Boolean).join(' | ');
const montoTexto = fmt(montoNuevo);

const encabezado = esManual
  ? '✅ ¡Registro guardado con éxito!'
  : '🤖 <b>Registrado automáticamente</b> (' + esc(mov.origen) + ')';
const mensajeOk = encabezado + '\\n\\n' +
  '📊 <b>Tipo:</b> ' + mov.tipo + '\\n' +
  '💰 <b>Monto:</b> $' + montoTexto + ' ' + mov.moneda + '\\n' +
  '🏷️ <b>Categoría:</b> ' + esc(mov.categoria) + '\\n' +
  '💳 <b>Método:</b> ' + esc(mov.metodo_pago) + '\\n' +
  '📝 <b>Detalle:</b> ' + esc(mov.descripcion) + '\\n' +
  '📅 <b>Fecha:</b> ' + mov.fecha;

const lista = duplicados.slice(-3).map(f =>
  '• ' + f.Fecha + ' · $' + fmt(f.Monto) + ' ' + f.Moneda + ' · ' + (f['Descripción'] || '-') + ' (' + (f['Método de Pago'] || '-') + ')'
).join('\\n');
const pregunta = '⚠️ Posible gasto duplicado\\n\\n' +
  'Nuevo (' + mov.origen + '):\\n• ' + mov.fecha + ' · $' + montoTexto + ' ' + mov.moneda + ' · ' + mov.descripcion + ' (' + mov.metodo_pago + ')\\n\\n' +
  'Ya registrado:\\n' + lista + '\\n\\n¿Lo agrego igual?';

return [{
  json: {
    ...mov,
    notas_final: notas,
    es_duplicado: duplicados.length > 0,
    cantidad_duplicados: duplicados.length,
    mensaje_ok: mensajeOk,
    mensaje_descartado: '🗑️ Descartado: $' + montoTexto + ' ' + mov.moneda + ' · ' + esc(mov.descripcion) + '. No se guardó nada.',
    pregunta,
  },
}];`;

const saldoCode = `// Mueve el saldo de la moneda del movimiento (pestaña Saldos: una fila por moneda, ARS/USD/EUR).
// Crédito (salvo pago de resumen) y efectivo no tocan saldos.
const mov = $('Buscar duplicados').first().json;
const filas = $input.all().map(i => i.json).filter(f => f && f.Moneda);

const normalizar = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
const tiene = (s, palabra) => new RegExp('(^|[^a-z])' + palabra + '([^a-z]|$)').test(s);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// "$12.345,67 ARS", "-$3.000 ARS"
const dinero = (n, moneda) => (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + ' ' + moneda;
// El Saldo llega como número; por las dudas acepta texto tipo "12.345,67"
const aNumero = v => typeof v === 'number' ? v
  : Number(String(v || '').replace(/[^\\d,.-]/g, '').replace(/\\./g, '').replace(',', '.')) || 0;
const NOMBRES = { ARS: 'pesos', USD: 'dólares', EUR: 'euros' };

const metodo = normalizar(mov.metodo_pago);
const detalle = normalizar(mov.descripcion + ' ' + mov.notas);
const moneda = String(mov.moneda || 'ARS').toUpperCase();

let motivo = '';
if (tiene(metodo, 'efectivo')) motivo = 'pagado en efectivo';
else if (metodo.includes('credito') && !detalle.includes('resumen')) motivo = 'pagado con tarjeta de crédito (se descuenta al pagar el resumen)';

const fila = motivo ? null : filas.find(f => String(f.Moneda).trim().toUpperCase() === moneda);
if (!motivo && !fila) motivo = filas.length ? 'no hay saldo en ' + moneda : 'no pude leer la pestaña Saldos';

if (motivo) {
  return [{ json: { actualizar: false, cuenta: moneda, linea_saldo: '\\n\\nℹ️ Saldos sin cambios: ' + esc(motivo) + '.' } }];
}

const signo = mov.tipo === 'INGRESO' ? 1 : -1;
const anterior = aNumero(fila.Saldo);
const nuevo = Math.round((anterior + signo * Number(mov.monto)) * 100) / 100;

return [{
  json: {
    actualizar: true,
    row_number: fila.row_number,
    cuenta: moneda,
    saldo_anterior: anterior,
    saldo_nuevo: nuevo,
    actualizado: $now.setZone('America/Argentina/Cordoba').toFormat('dd-MM-yyyy'),
    linea_saldo: '\\n\\n💰 <b>Saldo en ' + (NOMBRES[moneda] || moneda) + ':</b> ' + dinero(nuevo, moneda) + ' (antes ' + dinero(anterior, moneda) + ')',
  },
}];`;

const saldosTab = { __rl: true, mode: 'name', value: 'Saldos' };
const saldosSchema = [
  { id: 'Moneda', displayName: 'Moneda', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true, removed: true },
  { id: 'Saldo', displayName: 'Saldo', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true },
  { id: 'Actualizado', displayName: 'Actualizado', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
  { id: 'Notas', displayName: 'Notas', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true, removed: true },
  { id: 'row_number', displayName: 'row_number', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true, readOnly: true, removed: false }
];

const receive = trigger({
  type: 'n8n-nodes-base.executeWorkflowTrigger',
  version: 1.3,
  config: {
    name: 'Recibir movimiento',
    position: [0, 300],
    parameters: {
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'fecha', type: 'string' },
          { name: 'tipo', type: 'string' },
          { name: 'monto', type: 'number' },
          { name: 'moneda', type: 'string' },
          { name: 'categoria', type: 'string' },
          { name: 'descripcion', type: 'string' },
          { name: 'metodo_pago', type: 'string' },
          { name: 'notas', type: 'string' },
          { name: 'origen', type: 'string' },
          { name: 'chat_id', type: 'string' }
        ]
      }
    }
  }
});

const readRows = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Leer movimientos',
    position: [220, 300],
    executeOnce: true,
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    parameters: { resource: 'sheet', operation: 'read', authentication: 'oAuth2', documentId: doc, sheetName: tab },
    credentials: sheetsCred
  }
});

const findDups = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Buscar duplicados',
    position: [440, 300],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: dupCode }
  }
});

const isDup = ifElse({
  version: 2.3,
  config: {
    name: '¿Posible duplicado?',
    position: [660, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.es_duplicado }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const askUser = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Preguntar si agregar',
    position: [880, 160],
    parameters: {
      resource: 'message',
      operation: 'sendAndWait',
      chatId: expr('{{ $json.chat_id }}'),
      message: expr('{{ $json.pregunta }}'),
      responseType: 'approval',
      approvalOptions: { values: { approvalType: 'double', approveLabel: '✅ Agregar', disapproveLabel: '🗑️ Descartar' } },
      chatApproval: false,
      options: {
        limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 24, resumeUnit: 'hours' } },
        appendAttribution: false
      }
    },
    credentials: telegramCred
  }
});

const approved = ifElse({
  version: 2.3,
  config: {
    name: '¿Agregar?',
    position: [1100, 160],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.data?.approved === true }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const saveRow = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Guardar movimiento',
    position: [1340, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueErrorOutput',
    parameters: {
      resource: 'sheet',
      operation: 'append',
      authentication: 'oAuth2',
      documentId: doc,
      sheetName: tab,
      columns: {
        mappingMode: 'defineBelow',
        schema: colSchema,
        value: {
          'Fecha': expr('{{ $("Buscar duplicados").item.json.fecha }}'),
          'Tipo': expr('{{ $("Buscar duplicados").item.json.tipo }}'),
          'Monto': expr('{{ $("Buscar duplicados").item.json.monto }}'),
          'Moneda': expr('{{ $("Buscar duplicados").item.json.moneda }}'),
          'Categoría': expr('{{ $("Buscar duplicados").item.json.categoria }}'),
          'Descripción': expr('{{ $("Buscar duplicados").item.json.descripcion }}'),
          'Método de Pago': expr('{{ $("Buscar duplicados").item.json.metodo_pago }}'),
          'Notas': expr('{{ $("Buscar duplicados").item.json.notas_final }}')
        }
      },
      options: { cellFormat: 'RAW' }
    },
    credentials: sheetsCred
  }
});

const readBalances = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Leer saldos',
    position: [1600, 208],
    executeOnce: true,
    alwaysOutputData: true,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
    parameters: { resource: 'sheet', operation: 'read', authentication: 'oAuth2', documentId: doc, sheetName: saldosTab },
    credentials: sheetsCred
  }
});

const calcBalance = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Calcular saldo',
    position: [1808, 208],
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: saldoCode }
  }
});

const changesBalance = ifElse({
  version: 2.3,
  config: {
    name: '¿Cambia un saldo?',
    position: [2016, 208],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.actualizar }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const updateBalance = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Actualizar saldo',
    position: [2224, 112],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'sheet',
      operation: 'update',
      authentication: 'oAuth2',
      documentId: doc,
      sheetName: saldosTab,
      columns: {
        mappingMode: 'defineBelow',
        matchingColumns: ['row_number'],
        schema: saldosSchema,
        value: {
          'row_number': expr('{{ $json.row_number }}'),
          'Saldo': expr('{{ $json.saldo_nuevo }}'),
          'Actualizado': expr('{{ $json.actualizado }}')
        }
      },
      options: { cellFormat: 'RAW' }
    },
    credentials: sheetsCred
  }
});

const confirmOk = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Confirmar registro',
    position: [2448, 208],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 2000,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr("{{ $('Buscar duplicados').first().json.chat_id }}"),
      // Si Actualizar saldo falló, llega con json.error
      text: expr("{{ $('Buscar duplicados').first().json.mensaje_ok }}{{ $json.error ? '\\n\\n⚠️ No pude actualizar el saldo en ' + $('Calcular saldo').first().json.cuenta + '; corregilo a mano en la pestaña Saldos.' : $('Calcular saldo').first().json.linea_saldo }}"),
      replyMarkup: 'none',
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    },
    credentials: telegramCred
  }
});

const notifyDiscarded = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar descartado',
    position: [1340, 60],
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Buscar duplicados").item.json.chat_id }}'),
      text: expr('{{ $("Buscar duplicados").item.json.mensaje_descartado }}'),
      replyMarkup: 'none',
      additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    },
    credentials: telegramCred
  }
});

const notifyError = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar error al guardar',
    position: [1580, 440],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $("Buscar duplicados").item.json.chat_id }}'),
      text: expr('❌ No pude guardar en la hoja: ${{ $("Buscar duplicados").item.json.monto }} {{ $("Buscar duplicados").item.json.moneda }} · {{ $("Buscar duplicados").item.json.descripcion }}. Probá de nuevo en unos minutos.'),
      replyMarkup: 'none',
      additionalFields: { appendAttribution: false }
    },
    credentials: telegramCred
  }
});

const notes = sticky(
  '## Registrar movimiento (sub-workflow)\n\nLo usan el bot de Telegram y la captura automática (mails / Apple Pay).\n\nSi hay un movimiento con **mismo monto y moneda** y además **fecha ±1 día o mismo comercio**, pregunta por Telegram **[Agregar] / [Descartar]** (espera hasta 24 h; sin respuesta = descartado).\n\n**Saldos:** después de guardar suma o resta el monto en la fila de su moneda (ARS / USD / EUR) de la pestaña *Saldos*. Crédito (salvo pago de resumen) y efectivo no tocan saldos.',
  [receive, readRows, findDups],
  { color: 5 }
);

export default workflow('finanzas-registrar', 'Finanzas - Registrar movimiento (sub-workflow)')
  .add(receive)
  .to(readRows)
  .to(findDups)
  .to(isDup
    .onTrue(askUser.to(approved
      .onTrue(saveRow)
      .onFalse(notifyDiscarded)))
    .onFalse(saveRow))
  .add(saveRow)
  .to(readBalances)
  .to(calcBalance)
  .to(changesBalance
    .onTrue(updateBalance.to(confirmOk))
    .onFalse(confirmOk))
  .add(saveRow.onError(notifyError))
  .add(notes);
