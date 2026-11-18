// Fuente SDK de "Finanzas - Avisos (suscripciones + resumen semanal)".
// Se recrea con create_workflow_from_code del MCP de tu instancia de n8n.
// Todos los días 10:00: avisa si una suscripción se cobra en 2 días o si subió de precio (solo si hay algo).
// Domingos 21:00: resumen de la semana (totales, categorías vs promedio, presupuestos, cobros que vienen)
// con 2-3 observaciones de Claude Haiku 5.5.
import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

const SHEET_ID = 'TU_GOOGLE_SHEET_ID';
const sheetsCred = { googleSheetsOAuth2Api: { id: 'TU_CREDENCIAL_SHEETS', name: 'Google Sheets' } };
const telegramCred = { telegramApi: { id: 'TU_CREDENCIAL_TELEGRAM', name: 'Telegram account' } };
const anthropicCred = { anthropicApi: { id: 'TU_CREDENCIAL_ANTHROPIC', name: 'Anthropic' } };
const doc = { __rl: true, mode: 'id', value: SHEET_ID };

const analizarCode = `// Detecta suscripciones en Transacciones y arma, según qué disparador corrió, los avisos diarios
// (cobro en 2 días, aumento de precio) o el resumen del domingo.
// Suscripción = mismo comercio y moneda, con 25 a 35 días y montos parecidos (±50%) entre los dos últimos cobros.
let semanal = false;
try { semanal = $('Domingo 21:00').isExecuted; } catch (e) {}
const filas = $('Leer movimientos').all().map(i => i.json).filter(f => f && f.Monto !== undefined && f.Monto !== '');
const presupuestos = $('Leer presupuestos').all().map(i => i.json).filter(p => p && p['Categoría']);

const aDia = f => { const m = String(f || '').match(/^(\\d{2})-(\\d{2})-(\\d{4})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000 : null; };
const aTexto = d => { const f = new Date(d * 86400000); return String(f.getUTCDate()).padStart(2, '0') + '-' + String(f.getUTCMonth() + 1).padStart(2, '0'); };
const aNumero = v => typeof v === 'number' ? v
  : Number(String(v || '').replace(/[^\\d,.-]/g, '').replace(/\\./g, '').replace(',', '.')) || 0;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dinero = (n, m) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }) + ' ' + m;
const pct = x => (x >= 0 ? '+' : '') + Math.round(x * 100) + '%';
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const mesSiguiente = d => {
  const f = new Date(d * 86400000);
  const y = f.getUTCFullYear(), m = f.getUTCMonth() + 1;
  const fin = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(f.getUTCDate(), fin)) / 86400000;
};
const movimiento = f => ({ dia: aDia(f.Fecha), monto: Number(f.Monto) || 0, moneda: String(f.Moneda || 'ARS').toUpperCase(), cat: f['Categoría'] || 'Otros', desc: String(f['Descripción'] || '').trim() });

const hoy = aDia($now.setZone('America/Argentina/Cordoba').toFormat('dd-MM-yyyy'));
const gastos = filas.filter(f => f.Tipo === 'GASTO').map(movimiento).filter(g => g.dia !== null && g.monto > 0);
const ingresos = filas.filter(f => f.Tipo === 'INGRESO').map(movimiento).filter(g => g.dia !== null && g.monto > 0);

const grupos = {};
for (const g of gastos) {
  if (g.dia < hoy - 130 || !norm(g.desc)) continue;
  const k = norm(g.desc) + '|' + g.moneda;
  (grupos[k] = grupos[k] || []).push(g);
}
const subs = [];
for (const lista of Object.values(grupos)) {
  if (lista.length < 2) continue;
  lista.sort((a, b) => a.dia - b.dia);
  const ult = lista[lista.length - 1], ant = lista[lista.length - 2];
  const gap = ult.dia - ant.dia;
  if (gap < 25 || gap > 35 || hoy - ult.dia > 40 || Math.abs(ult.monto - ant.monto) > ant.monto * 0.5) continue;
  subs.push({ desc: ult.desc, moneda: ult.moneda, monto: ult.monto, anterior: ant.monto, ultimo: ult.dia, proximo: mesSiguiente(ult.dia) });
}

if (!semanal) {
  const avisos = [];
  for (const s of subs) {
    if (s.proximo - hoy === 2) avisos.push('🔔 En 2 días (' + aTexto(s.proximo) + ') se cobra <b>' + esc(s.desc) + '</b>: ~' + dinero(s.monto, s.moneda));
    if (s.ultimo >= hoy - 1 && s.monto > s.anterior * 1.03) {
      avisos.push('📈 <b>' + esc(s.desc) + '</b> subió: ' + dinero(s.anterior, s.moneda) + ' → ' + dinero(s.monto, s.moneda) + ' (' + pct(s.monto / s.anterior - 1) + ')');
    }
  }
  return [{ json: { modo: 'diario', mensaje: avisos.length ? '🗓️ <b>Avisos de suscripciones</b>\\n\\n' + avisos.join('\\n') : '' } }];
}

// Resumen semanal: lunes a domingo
const desde = hoy - 6;
const sumarPorMoneda = lista => { const t = {}; lista.forEach(g => { t[g.moneda] = (t[g.moneda] || 0) + g.monto; }); return t; };
const linea = t => Object.keys(t).length ? Object.entries(t).map(([m, v]) => dinero(v, m)).join(' · ') : '$0';
const enSemana = gastos.filter(g => g.dia >= desde && g.dia <= hoy);
const totales = sumarPorMoneda(enSemana);
const ingSemana = sumarPorMoneda(ingresos.filter(g => g.dia >= desde && g.dia <= hoy));
const semanaAnterior = gastos.filter(g => g.moneda === 'ARS' && g.dia >= desde - 7 && g.dia < desde).reduce((s, g) => s + g.monto, 0);

// Categorías en pesos: esta semana vs promedio semanal de hasta 8 semanas anteriores,
// contando solo las semanas que la hoja tiene historia (con menos de 2 no se compara)
const primerDia = gastos.reduce((min, g) => Math.min(min, g.dia), hoy);
const semanasHist = Math.min(8, Math.floor((desde - primerDia) / 7));
const catSemana = {}, catPrev = {};
for (const g of gastos) {
  if (g.moneda !== 'ARS') continue;
  if (g.dia >= desde && g.dia <= hoy) catSemana[g.cat] = (catSemana[g.cat] || 0) + g.monto;
  else if (g.dia >= desde - semanasHist * 7 && g.dia < desde) catPrev[g.cat] = (catPrev[g.cat] || 0) + g.monto;
}
const cats = Object.entries(catSemana).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cat, v]) => {
  const prom = semanasHist >= 2 ? (catPrev[cat] || 0) / semanasHist : 0;
  return { cat, semana: Math.round(v), promedio_semanal: Math.round(prom), variacion: prom ? v / prom - 1 : null };
});

const f = new Date(hoy * 86400000);
const inicioMes = Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1) / 86400000;
const pres = presupuestos.filter(p => aNumero(p['Monto mensual']) > 0).map(p => {
  const m = String(p.Moneda || 'ARS').toUpperCase();
  const tope = aNumero(p['Monto mensual']);
  const gastado = gastos.filter(x => x.cat === p['Categoría'] && x.moneda === m && x.dia >= inicioMes && x.dia <= hoy).reduce((s, x) => s + x.monto, 0);
  return { cat: p['Categoría'], moneda: m, gastado: Math.round(gastado), tope, pct: Math.round(gastado / tope * 100) };
});
const proximos = subs.filter(s => s.proximo > hoy && s.proximo <= hoy + 7)
  .map(s => ({ desc: s.desc, moneda: s.moneda, monto: s.monto, fecha: aTexto(s.proximo) }));

let msg = '🗓️ <b>Tu semana (' + aTexto(desde) + ' al ' + aTexto(hoy) + ')</b>\\n\\n💸 <b>Gastos:</b> ' + linea(totales);
if (Object.keys(ingSemana).length) msg += '\\n💰 <b>Ingresos:</b> ' + linea(ingSemana);
if (totales.ARS && semanaAnterior) msg += '\\n↔️ vs semana anterior: ' + pct(totales.ARS / semanaAnterior - 1) + ' en pesos';
if (cats.length) {
  msg += '\\n\\n🏷️ <b>Categorías (ARS):</b>\\n' + cats.map(c => '• ' + esc(c.cat) + ': ' + dinero(c.semana, 'ARS') +
    (c.variacion !== null ? ' (' + pct(c.variacion) + ' vs tu promedio)' : '')).join('\\n');
}
if (pres.length) {
  msg += '\\n\\n🎯 <b>Presupuestos del mes:</b>\\n' + pres.map(p => '• ' + (p.pct >= 100 ? '🔴' : p.pct >= 80 ? '🟡' : '🟢') + ' ' +
    esc(p.cat) + ': ' + p.pct + '% (' + dinero(p.gastado, p.moneda) + ' de ' + dinero(p.tope, p.moneda) + ')').join('\\n');
}
if (proximos.length) {
  msg += '\\n\\n🔔 <b>Se cobran esta semana:</b>\\n' + proximos.map(s => '• ' + esc(s.desc) + ' ~' + dinero(s.monto, s.moneda) + ' (' + s.fecha + ')').join('\\n');
}

const datos = { gastos_semana: totales, ingresos_semana: ingSemana, gastos_semana_anterior_ARS: Math.round(semanaAnterior),
  categorias_ARS: cats.map(c => ({ ...c, variacion: c.variacion === null ? null : pct(c.variacion) })), presupuestos: pres,
  suscripciones_proximas: proximos, movimientos_semana: enSemana.length };
return [{ json: { modo: 'semanal', mensaje: msg, datos: JSON.stringify(datos) } }];`;

const armarCode = `// Suma las observaciones de Claude (si respondió) al resumen con los números ya calculados.
const base = $('Analizar movimientos').first().json.mensaje;
const r = $json;
let texto = '';
if (typeof r.merged_response === 'string') texto = r.merged_response;
else if (Array.isArray(r.content)) texto = r.content.filter(c => c && c.type === 'text').map(c => c.text).join('\\n');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const obs = texto.split('\\n').map(l => l.trim()).filter(l => l.startsWith('•')).slice(0, 3);
return [{ json: { mensaje: base + (obs.length ? '\\n\\n💡 <b>Observaciones</b>\\n' + obs.map(esc).join('\\n') : '') } }];`;

const cadaDia = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Cada día 10:00', position: [0, 200], parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 10, triggerAtMinute: 0 }] } } }
});

const domingo = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Domingo 21:00', position: [0, 420], parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [0], triggerAtHour: 21, triggerAtMinute: 0 }] } } }
});

const leerMovimientos = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Leer movimientos', position: [240, 300], executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: { resource: 'sheet', operation: 'read', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'Transacciones' }, options: {} },
    credentials: sheetsCred
  }
});

const leerPresupuestos = node({
  type: 'n8n-nodes-base.googleSheets',
  version: 4.7,
  config: {
    name: 'Leer presupuestos', position: [460, 300], executeOnce: true, alwaysOutputData: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
    parameters: { resource: 'sheet', operation: 'read', authentication: 'oAuth2', documentId: doc, sheetName: { __rl: true, mode: 'name', value: 'Presupuestos' }, options: {} },
    credentials: sheetsCred
  }
});

const analizar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Analizar movimientos', position: [680, 300], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: analizarCode } }
});

const esSemanal = ifElse({
  version: 2.2,
  config: {
    name: '¿Es el resumen semanal?', position: [900, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.modo }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'semanal' }],
        combinator: 'and'
      }
    }
  }
});

const claude = node({
  type: '@n8n/n8n-nodes-langchain.anthropic',
  version: 1,
  config: {
    name: 'Claude - Observaciones', position: [1120, 200], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
    parameters: {
      resource: 'text', operation: 'message',
      modelId: { __rl: true, mode: 'id', value: 'claude-haiku-5-5' },
      messages: { values: [{ content: expr('{{ $json.datos }}') }] },
      options: {
        includeMergedResponse: true,
        maxTokens: 300,
        system: 'Sos un asesor de finanzas personales argentino, directo y amable. Recibís en JSON el resumen de la semana de una persona (montos en su moneda; las variaciones ya vienen calculadas). Escribí EXACTAMENTE 2 o 3 observaciones breves (máximo 20 palabras cada una), en español rioplatense, cada una en su propia línea empezando con "• ". Enfocate en lo más llamativo: categorías muy por encima o por debajo del promedio, presupuestos en riesgo, cobros que vienen o una buena semana. Usá solo los números del JSON, no inventes datos. Sin títulos, sin markdown, sin HTML.'
      }
    },
    credentials: anthropicCred
  }
});

const armar = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Armar resumen', position: [1340, 200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: armarCode } }
});

const enviarResumen = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Enviar resumen', position: [1560, 200], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: {
      resource: 'message', operation: 'sendMessage', chatId: 'TU_CHAT_ID_TELEGRAM', text: expr('{{ $json.mensaje }}'),
      replyMarkup: 'none', additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    },
    credentials: telegramCred
  }
});

const hayAvisos = ifElse({
  version: 2.2,
  config: {
    name: '¿Hay avisos?', position: [1120, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.mensaje }}'), operator: { type: 'string', operation: 'notEmpty', singleValue: true } }],
        combinator: 'and'
      }
    }
  }
});

const enviarAvisos = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Enviar avisos', position: [1340, 420], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: {
      resource: 'message', operation: 'sendMessage', chatId: 'TU_CHAT_ID_TELEGRAM', text: expr('{{ $json.mensaje }}'),
      replyMarkup: 'none', additionalFields: { appendAttribution: false, parse_mode: 'HTML' }
    },
    credentials: telegramCred
  }
});

const notas = sticky(
  '## Avisos de finanzas\n\n**Todos los días 10:00:** detecta suscripciones (mismo comercio, cobro mensual) y avisa si una se cobra en 2 días o si subió de precio. Si no hay nada, no manda mensaje.\n\n**Domingo 21:00:** resumen de la semana con categorías vs tu promedio, presupuestos y cobros que vienen, más 2-3 observaciones de Claude.',
  [cadaDia, domingo, leerMovimientos, leerPresupuestos],
  { color: 6 }
);

export default workflow('finanzas-avisos', 'Finanzas - Avisos (suscripciones + resumen semanal)')
  .add(cadaDia)
  .to(leerMovimientos)
  .add(domingo)
  .to(leerMovimientos)
  .to(leerPresupuestos)
  .to(analizar)
  .to(esSemanal
    .onTrue(claude.to(armar.to(enviarResumen)))
    .onFalse(hayAvisos.onTrue(enviarAvisos)))
  .add(notas);
