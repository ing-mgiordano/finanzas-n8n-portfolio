// Arma la respuesta de "¿cuánto tengo?" con la pestaña Saldos (una fila por moneda: ARS, USD, EUR,
// que nunca se suman entre sí) y la pestaña Cripto (saldos de Binance en USD, la escribe cada hora
// el workflow "Finanzas - Saldos cripto Binance"). La cripto se suma solo a los dólares.
const q = $('Limpiar y parsear JSON').first().json;
const filas = $('Leer saldos').all().map(i => i.json).filter(f => f && f.Moneda);
const cripto = $('Leer cripto').all().map(i => i.json).filter(f => f && f.Activo);

const dinero = (n, moneda) => (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }) + ' ' + moneda;
const aNumero = v => typeof v === 'number' ? v
  : Number(String(v || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
// La hoja Cripto guarda texto con punto decimal ("6457.67"); acepta coma por si se edita a mano.
const aNumeroCripto = v => {
  if (typeof v === 'number') return v;
  let t = String(v || '').trim().replace(/[^\d.,-]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return Number(t) || 0;
};
// Actualizado puede venir como texto DD-MM-YYYY o como número de serie de fecha de Sheets
const aDia = v => {
  if (typeof v === 'number') return Math.floor(v) - 25569;
  const m = String(v || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 86400000 : null;
};
const diaATexto = d => {
  const f = new Date(d * 86400000);
  return String(f.getUTCDate()).padStart(2, '0') + '-' + String(f.getUTCMonth() + 1).padStart(2, '0') + '-' + f.getUTCFullYear();
};

if (!filas.length) {
  return [{ json: { chat_id: q.chat_id, mensaje: '❌ No pude leer la pestaña Saldos. Probá de nuevo en unos minutos.' } }];
}

const ETIQUETAS = { ARS: '🇦🇷 Pesos', USD: '🇺🇸 Dólares', EUR: '🇪🇺 Euros' };
const ORDEN = ['ARS', 'USD', 'EUR'];
const moneda = f => String(f.Moneda).trim().toUpperCase();
const ordenadas = filas.slice().sort((a, b) => {
  const ia = ORDEN.indexOf(moneda(a)), ib = ORDEN.indexOf(moneda(b));
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});

let msg = '💳 <b>¿Cuánto tengo?</b>\n\n' + ordenadas
  .map(f => '<b>' + (ETIQUETAS[moneda(f)] || moneda(f)) + ':</b> ' + dinero(aNumero(f.Saldo), moneda(f)))
  .join('\n');

const conValor = cripto.map(f => ({ activo: String(f.Activo).trim(), usd: aNumeroCripto(f['Total USD']) })).filter(c => c.usd > 0);
if (conValor.length) {
  const totalCripto = Math.round(conValor.reduce((s, c) => s + c.usd, 0) * 100) / 100;
  const filaUsd = filas.find(f => moneda(f) === 'USD');
  const usd = filaUsd ? aNumero(filaUsd.Saldo) : 0;
  const top = conValor.sort((a, b) => b.usd - a.usd).slice(0, 3)
    .map(c => c.activo + ' ' + Math.round((c.usd / totalCripto) * 100) + '%').join(' · ');
  msg += '\n<b>🪙 Cripto (Binance):</b> ' + dinero(totalCripto, 'USD') + '\n   ' + top;
  msg += '\n\n💵 <b>Total en dólares (con cripto):</b> ' + dinero(Math.round((usd + totalCripto) * 100) / 100, 'USD');
} else {
  msg += '\n<b>🪙 Cripto (Binance):</b> sin datos por ahora';
}

const dias = filas.map(f => aDia(f.Actualizado)).filter(d => d !== null);
if (dias.length) msg += '\n\n🕒 Última actualización: ' + diaATexto(Math.max(...dias));
const criptoAct = cripto.length ? String(cripto[0].Actualizado || '').trim() : '';
if (criptoAct) msg += '\n🪙 Cripto actualizada: ' + criptoAct;

return [{ json: { chat_id: q.chat_id, mensaje: msg } }];
