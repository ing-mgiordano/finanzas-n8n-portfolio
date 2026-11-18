// Fuente SDK de "Finanzas - Patrimonio diario + IPC".
// Se recrea con create_workflow_from_code del MCP de tu instancia de n8n.
// Todos los días a las 23:00: foto del patrimonio (Saldos + Cripto, valuado con dólar MEP y EUR/USD)
// en la pestaña Patrimonio, y la inflación mensual (últimos 36 meses) en la pestaña IPC.
// APIs públicas sin clave: dolarapi.com (MEP), Binance ticker EURUSDT, argentinadatos (IPC).
import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const SHEET_ID = 'TU_GOOGLE_SHEET_ID';
const sheetsCred = { googleSheetsOAuth2Api: { id: 'TU_CREDENCIAL_SHEETS', name: 'Google Sheets' } };
const telegramCred = { telegramApi: { id: 'TU_CREDENCIAL_TELEGRAM', name: 'Telegram account' } };
const doc = { __rl: true, mode: 'id', value: SHEET_ID };

const fotoCode = `// Valúa todo el patrimonio en dólares: pesos al MEP (venta), euros con EUR/USD de Binance, cripto ya viene en USD.
const saldos = $('Leer saldos').all().map(i => i.json).filter(f => f && f.Moneda);
const cripto = $('Leer cripto').all().map(i => i.json).filter(f => f && f.Activo);
const mep = Number($('Dólar MEP').first().json.venta);
const eurUsd = Number($('EUR/USD').first().json.price);
if (!(mep > 0) || !(eurUsd > 0)) throw new Error('Cotización inválida: MEP ' + mep + ', EUR/USD ' + eurUsd);

// Saldo puede llegar como número o como texto con formato es-AR ("953.562,87")
const aNumero = v => typeof v === 'number' ? v
  : Number(String(v || '').replace(/[^\\d,.-]/g, '').replace(/\\./g, '').replace(',', '.')) || 0;
// La hoja Cripto guarda texto con punto decimal ("4990.75")
const aNumeroCripto = v => {
  if (typeof v === 'number') return v;
  let t = String(v || '').trim().replace(/[^\\d.,-]/g, '');
  if (t.includes(',')) t = t.replace(/\\./g, '').replace(',', '.');
  return Number(t) || 0;
};
const saldo = m => { const f = saldos.find(s => String(s.Moneda).trim().toUpperCase() === m); return f ? aNumero(f.Saldo) : 0; };
const r2 = n => Math.round(n * 100) / 100;

const ars = saldo('ARS'), usd = saldo('USD'), eur = saldo('EUR');
const criptoUsd = r2(cripto.reduce((s, c) => s + aNumeroCripto(c['Total USD']), 0));
const totalUsd = r2(ars / mep + usd + eur * eurUsd + criptoUsd);

return [{ json: {
  Fecha: $now.setZone('America/Argentina/Cordoba').toFormat('dd-MM-yyyy'),
  ARS: r2(ars), USD: r2(usd), EUR: r2(eur), 'Cripto USD': criptoUsd,
  'Dólar MEP': mep, 'EUR/USD': Math.round(eurUsd * 10000) / 10000,
  'Total USD': totalUsd, 'Total ARS': r2(totalUsd * mep),
} }];`;

const ipcCode = `// Últimos 36 meses de inflación mensual (INDEC vía argentinadatos) para comparar gastos en términos reales.
const datos = $('Inflación').all().map(i => i.json).filter(d => d && d.fecha && d.valor !== undefined);
return datos.slice(-36).map(d => ({ json: { Mes: String(d.fecha).slice(0, 7), 'Inflación %': Number(d.valor) } }));`;

const cadaDia = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Cada día 23:00', position: [0, 300], parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 23, triggerAtMinute: 0 }] } } }
});

const leerSaldos = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Leer saldos', position: [220, 300], executeOnce: true, alwaysOutputData: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: { resource: 'sheet', operation: 'read', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'Saldos' }, options: {} },
    credentials: sheetsCred
  }
});
const leerCripto = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Leer cripto', position: [440, 300], executeOnce: true, alwaysOutputData: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: { resource: 'sheet', operation: 'read', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'Cripto' }, options: {} },
    credentials: sheetsCred
  }
});
const mepNode = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Dólar MEP', position: [660, 300], executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
    parameters: { method: 'GET', url: 'https://dolarapi.com/v1/dolares/bolsa', authentication: 'none', options: { timeout: 15000 } }
  }
});
const eurNode = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'EUR/USD', position: [880, 300], executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
    parameters: { method: 'GET', url: 'https://api.binance.com/api/v3/ticker/price?symbol=EURUSDT', authentication: 'none', options: { timeout: 15000 } }
  }
});
const ipcNode = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Inflación', position: [1100, 300], executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    onError: 'continueErrorOutput',
    parameters: { method: 'GET', url: 'https://api.argentinadatos.com/v1/finanzas/indices/inflacion', authentication: 'none', options: { timeout: 15000 } }
  }
});

const foto = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Armar foto del patrimonio', position: [1320, 300], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: fotoCode } }
});

const guardarFoto = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Guardar en Patrimonio', position: [1540, 300], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: {
      resource: 'sheet', operation: 'appendOrUpdate', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'Patrimonio' },
      columns: {
        mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['Fecha'],
        schema: [{ id: 'Fecha', displayName: 'Fecha', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }, { id: 'ARS', displayName: 'ARS', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }, { id: 'USD', displayName: 'USD', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }, { id: 'EUR', displayName: 'EUR', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }, { id: 'Cripto USD', displayName: 'Cripto USD', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' },
          { id: 'Dólar MEP', displayName: 'Dólar MEP', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }, { id: 'EUR/USD', displayName: 'EUR/USD', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }, { id: 'Total USD', displayName: 'Total USD', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }, { id: 'Total ARS', displayName: 'Total ARS', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }]
      },
      options: { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' }
    },
    credentials: sheetsCred
  }
});

const vaciarIpc = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Vaciar IPC', position: [1760, 300], executeOnce: true,
    parameters: { resource: 'sheet', operation: 'clear', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'IPC' }, clear: 'wholeSheet', keepFirstRow: true },
    credentials: sheetsCred
  }
});

const filasIpc = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Filas IPC', position: [1980, 300], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ipcCode } }
});

const escribirIpc = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Escribir IPC', position: [2200, 300],
    parameters: {
      resource: 'sheet', operation: 'append', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'IPC' },
      columns: { mappingMode: 'autoMapInputData', value: {}, schema: [{ id: 'Mes', displayName: 'Mes', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string' }, { id: 'Inflación %', displayName: 'Inflación %', required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'number' }] },
      options: { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' }
    },
    credentials: sheetsCred
  }
});

const avisar = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Avisar error de cotización', position: [1100, 540], executeOnce: true, onError: 'continueRegularOutput',
    parameters: {
      resource: 'message', operation: 'sendMessage', chatId: 'TU_CHAT_ID_TELEGRAM',
      text: expr('⚠️ No pude guardar la foto diaria del patrimonio (falló una cotización): {{ $json.error && ($json.error.message || $json.error) }}'),
      replyMarkup: 'none', additionalFields: { appendAttribution: false }
    },
    credentials: telegramCred
  }
});

const notas = sticky(
  '## Patrimonio diario + IPC\n\nA las 23:00 lee **Saldos** y **Cripto**, valúa todo en USD (pesos al **dólar MEP**, euros con **EUR/USD** de Binance) y guarda una fila por día en **Patrimonio** (si corre dos veces el mismo día, la pisa).\n\nTambién reescribe **IPC** con la inflación mensual de los últimos 36 meses. Si falla una cotización, avisa por Telegram.',
  [cadaDia, leerSaldos, leerCripto, mepNode],
  { color: 6 }
);

export default workflow('finanzas-patrimonio', 'Finanzas - Patrimonio diario + IPC')
  .add(cadaDia)
  .to(leerSaldos)
  .to(leerCripto)
  .to(mepNode)
  .to(eurNode)
  .to(ipcNode)
  .to(foto)
  .to(guardarFoto)
  .to(vaciarIpc)
  .to(filasIpc)
  .to(escribirIpc)
  .add(mepNode.onError(avisar))
  .add(eurNode.onError(avisar))
  .add(ipcNode.onError(avisar))
  .add(notas);
