/* Faktury – Koření od Havrana
   Vše se ukládá v tomto prohlížeči (localStorage). Zálohu stáhnete v Nastavení. */
'use strict';

const KEY = 'havran-faktury-v1';
const DRAFT_KEY = 'havran-faktury-draft';

/* ---------- pomocné funkce ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
const num = s => { const n = parseFloat(String(s ?? '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const uid = p => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtNum = (n, d = 2) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const kc = n => fmtNum(n) + ' Kč';
const today = () => isoDate(new Date());
function isoDate(d) { const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
function addDays(iso, days) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + Number(days || 0)); return isoDate(d); }
function fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${+d}. ${+m}. ${y}`; }

function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' toast-bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200);
}

/* ---------- data ---------- */
let db = loadDb();
function loadDb() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Uložení se nepovedlo – v prohlížeči došlo místo. Stáhněte zálohu.', true); }
  renderBackupInfo();
}
function emptyDb() {
  return {
    version: 1,
    settings: { brand: 'Koření od Havrana', supplier: { name: '', street: '', city: '', ico: '', dic: '', bank: '', account: '', phone: '', email: '' }, ks: '', dueDays: 14, payment: 'Převodem', roundTotal: true, note: 'Fyzická osoba zapsaná v živnostenském rejstříku.', issuer: '' },
    pricelists: [{ id: 'zakladni', name: 'Základní ceník' }],
    products: [], customers: [], invoices: [], lastBackup: null
  };
}
function fixDb(d) {
  const e = emptyDb();
  d.settings = Object.assign(e.settings, d.settings || {});
  d.settings.supplier = Object.assign(e.settings.supplier, d.settings.supplier || {});
  for (const k of ['pricelists', 'products', 'customers', 'invoices']) if (!Array.isArray(d[k])) d[k] = e[k];
  if (!d.pricelists.length) d.pricelists = e.pricelists;
  d.products.forEach(p => { p.prices = p.prices || {}; if (p.vat == null) p.vat = 12; });
  return d;
}
if (db) db = fixDb(db);
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { }

const custById = id => db.customers.find(c => c.id === id);
const prodById = id => db.products.find(p => p.id === id);
const plName = id => (db.pricelists.find(p => p.id === id) || {}).name || '—';
const sortCz = (a, b) => a.localeCompare(b, 'cs');

/* ---------- výpočty ---------- */
function calc(items, roundTotal = db.settings.roundTotal) {
  const rates = {}; let base = 0, vat = 0;
  const lines = items.filter(i => num(i.qty) > 0).map(i => {
    const b = r2(num(i.qty) * num(i.price)), v = r2(b * num(i.vat) / 100);
    const r = rates[i.vat] || (rates[i.vat] = { base: 0, vat: 0 });
    r.base = r2(r.base + b); r.vat = r2(r.vat + v);
    base = r2(base + b); vat = r2(vat + v);
    return { ...i, base: b, vatAmt: v, total: r2(b + v) };
  });
  const total = r2(base + vat);
  const pay = roundTotal ? Math.round(total) : total;
  return { lines, rates, base, vat, total, pay, rounding: r2(pay - total) };
}
function lineCalc(i) { const b = r2(num(i.qty) * num(i.price)), v = r2(b * num(i.vat) / 100); return { base: b, vat: v, total: r2(b + v) }; }

function nextNumber() {
  const yy = String(new Date().getFullYear()).slice(2);
  const nums = db.invoices.map(i => String(i.number)).filter(n => /^\d{6}$/.test(n) && n.startsWith(yy)).map(Number);
  return nums.length ? String(Math.max(...nums) + 1) : yy + '0001';
}
function lastInvoiceOf(customerId) {
  return db.invoices.filter(i => i.customerId === customerId).sort((a, b) => (b.issued + b.number).localeCompare(a.issued + a.number))[0];
}
function priceFor(product, pricelistId) {
  const p = product.prices[pricelistId];
  if (p != null && p !== '') return num(p);
  const z = product.prices.zakladni; return z != null && z !== '' ? num(z) : null;
}

/* QR platba – český účet na IBAN + SPAYD */
function toIBAN(acc) {
  const m = String(acc || '').replace(/\s/g, '').match(/^(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})$/);
  if (!m) return null;
  const bban = m[3] + (m[1] || '').padStart(6, '0') + m[2].padStart(10, '0');
  const chk = 98n - (BigInt(bban + '123500') % 97n);
  return 'CZ' + String(chk).padStart(2, '0') + bban;
}
function qrSvg(inv, amount) {
  const iban = toIBAN((inv.supplier || db.settings.supplier).account);
  if (!iban || typeof qrcode === 'undefined' || inv.payment === 'Hotově') return '';
  let s = `SPD*1.0*ACC:${iban}*AM:${amount.toFixed(2)}*CC:CZK*X-VS:${String(inv.vs || inv.number).replace(/\D/g, '')}`;
  if (inv.ks) s += `*X-KS:${String(inv.ks).replace(/\D/g, '')}`;
  if (inv.due) s += `*DT:${inv.due.replace(/-/g, '')}`;
  s += `*MSG:${norm('Faktura ' + inv.number).toUpperCase().replace(/\*/g, '')}`;
  const q = qrcode(0, 'M'); q.addData(s); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

/* ---------- navigace ---------- */
let view = 'nova';
function go(v) { view = v; render(); window.scrollTo(0, 0); }
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) go(b.dataset.view); });

function render() {
  $('#brandName').textContent = db ? db.settings.brand || 'Faktury' : 'Faktury';
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#nav').style.visibility = db ? '' : 'hidden';
  const main = $('#main');
  if (!db) { main.innerHTML = viewWelcome(); return; }
  ({ nova: renderEditor, faktury: renderInvoices, odberatele: renderCustomers, cenik: renderPricelist, nastaveni: renderSettings })[view]();
  renderBackupInfo();
}
function renderBackupInfo() {
  const el = $('#backupInfo'); if (!db) { el.innerHTML = ''; return; }
  const lb = db.lastBackup;
  const days = lb ? Math.floor((Date.now() - new Date(lb).getTime()) / 864e5) : null;
  const warn = db.invoices.length && (days == null || days > 14);
  el.innerHTML = `<div class="${warn ? 'backup-warn' : ''}">${lb ? 'Poslední záloha: ' + fmtDate(lb.slice(0, 10)) : 'Záloha zatím nebyla stažena'}</div>
    ${warn ? '<button class="btn btn-small btn-turmeric" data-action="backup">Stáhnout zálohu</button>' : ''}`;
}

/* ---------- úvod ---------- */
function viewWelcome() {
  return `<section class="welcome">
    <h1>Fakturace koření</h1>
    <p>Než začnete, načtěte počáteční data – ceníky, odběratele a údaje dodavatele. Soubor se jmenuje <b>havran-pocatecni-data.json</b>.</p>
    <div class="welcome-actions">
      <label class="btn btn-primary btn-lg">Načíst počáteční data<input type="file" accept=".json,application/json" data-action="import-file" hidden></label>
      <button class="btn btn-lg" data-action="start-empty">Začít bez dat</button>
    </div>
  </section>`;
}

/* ---------- editor faktury ---------- */
let draft = null; // rozpracovaná faktura
function newDraft(customerId) {
  const s = db.settings, iss = today();
  const d = { id: null, number: nextNumber(), customerId: customerId || '', issued: iss, duzp: iss, due: addDays(iss, s.dueDays), payment: s.payment || 'Převodem', ks: s.ks, items: [], note: '' };
  if (customerId) loadTemplate(d);
  return d;
}
function loadTemplate(d) {
  const c = custById(d.customerId); const last = lastInvoiceOf(d.customerId);
  if (!c || !last) { d.items = []; return false; }
  d.items = last.items.map(i => {
    const p = prodById(i.productId); const pr = p ? priceFor(p, c.pricelist) : null;
    return { productId: i.productId, name: p ? p.name : i.name, weight: p ? p.weight : i.weight, qty: i.qty, price: pr != null ? pr : i.price, vat: p ? p.vat : i.vat };
  });
  return true;
}
function storeDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { } }
function clearDraft() { draft = null; try { localStorage.removeItem(DRAFT_KEY); } catch { } }
function ensureDraft() {
  if (draft) return;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { }
  if (!draft) draft = newDraft();
}

function renderEditor() {
  ensureDraft();
  const d = draft, c = custById(d.customerId);
  const editing = !!d.id;
  const custOpts = db.customers.slice().sort((a, b) => sortCz(a.name, b.name))
    .map(x => `<option value="${esc(x.id)}" ${x.id === d.customerId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const last = c && lastInvoiceOf(c.id);
  $('#main').innerHTML = `
  <header class="page-head">
    <h1>${editing ? 'Úprava faktury ' + esc(d.number) : 'Nová faktura'}</h1>
    <div class="head-actions">
      ${editing ? '<button class="btn btn-ghost" data-action="draft-discard">Zrušit úpravy</button>' : (d.items.length || d.customerId ? '<button class="btn btn-ghost" data-action="draft-discard">Začít znovu</button>' : '')}
    </div>
  </header>
  <div class="editor">
    <div class="editor-main">
      <section class="panel">
        <label class="field field-big">
          <span>Komu fakturujete</span>
          <select id="fCustomer"><option value="">— vyberte odběratele —</option>${custOpts}</select>
        </label>
        ${c ? `<div class="cust-line">${esc([c.street, c.city].filter(Boolean).join(', '))}${c.ico ? ' &nbsp;|&nbsp; IČ ' + esc(c.ico) : ''} &nbsp;|&nbsp; <b>${esc(plName(c.pricelist))}</b></div>` : `<p class="hint">Odběratel tu chybí? <button class="link" data-action="go-customers-new">Přidat nového odběratele</button></p>`}
      </section>

      ${c ? `
      <section class="panel">
        <div class="items-head">
          <h2>Položky</h2>
          <div class="items-tools">
            ${last ? `<button class="btn btn-small" data-action="load-last">Načíst položky z faktury ${esc(last.number)}</button>` : ''}
            ${d.items.length ? '<button class="btn btn-small" data-action="zero-qty">Vynulovat počty</button><button class="btn btn-small" data-action="reprice">Ceny podle ceníku</button>' : ''}
          </div>
        </div>
        <div class="add-wrap">
          <input id="addSearch" class="add-search" type="search" autocomplete="off" placeholder="Přidat koření – začněte psát název, např. sůl">
          <div id="addList" class="add-list" hidden></div>
        </div>
        ${d.items.length ? `
        <div class="table-wrap"><table class="items">
          <thead><tr><th>Koření</th><th class="r">Počet ks</th><th class="r">Cena za ks<br><small>bez DPH</small></th><th class="r">Bez DPH</th><th class="r">Celkem<br><small>s DPH</small></th><th></th></tr></thead>
          <tbody>${d.items.map((it, i) => itemRow(it, i)).join('')}</tbody>
        </table></div>
        <p class="hint">Položky s počtem 0 se na fakturu nevytisknou.</p>` : `<div class="empty">Zatím žádné položky. Napište do pole výše název koření a stiskněte Enter.</div>`}
      </section>` : ''}
    </div>

    <aside class="editor-side">
      <section class="panel total-panel" id="totals">${totalsHtml()}</section>
      <div class="side-actions">
        <button class="btn btn-primary btn-lg" data-action="save-print">Uložit a zobrazit fakturu</button>
        <button class="btn btn-lg" data-action="save">Jen uložit</button>
      </div>
      <section class="panel">
        <div class="grid2">
          <label class="field"><span>Číslo faktury</span><input id="fNumber" value="${esc(d.number)}" inputmode="numeric"></label>
          <label class="field"><span>Variabilní symbol</span><input id="fVs" value="${esc(d.number)}" disabled title="Stejný jako číslo faktury"></label>
          <label class="field"><span>Datum vystavení</span><input id="fIssued" type="date" value="${esc(d.issued)}"></label>
          <label class="field"><span>Datum zdan. plnění</span><input id="fDuzp" type="date" value="${esc(d.duzp)}"></label>
          <label class="field"><span>Splatnost</span><input id="fDue" type="date" value="${esc(d.due)}"></label>
          <label class="field"><span>Forma úhrady</span><select id="fPayment">${['Převodem', 'Hotově'].map(p => `<option ${p === d.payment ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Poznámka na faktuře (nepovinné)</span><input id="fNote" value="${esc(d.note)}"></label>
      </section>
    </aside>
  </div>`;
  bindEditor();
}
function itemRow(it, i) {
  const l = lineCalc(it);
  return `<tr data-i="${i}" class="${num(it.qty) > 0 ? '' : 'zero'}">
    <td class="it-name">${esc(it.name)} <span class="it-w">${esc(it.weight)}</span></td>
    <td class="r"><div class="qty">
      <button class="qbtn" data-action="qty-minus" tabindex="-1" aria-label="Ubrat">−</button>
      <input class="in-qty" data-f="qty" value="${esc(it.qty)}" inputmode="decimal">
      <button class="qbtn" data-action="qty-plus" tabindex="-1" aria-label="Přidat">+</button></div></td>
    <td class="r"><input class="in-price" data-f="price" value="${esc(fmtNum(num(it.price)))}" inputmode="decimal"></td>
    <td class="r c-base">${fmtNum(l.base)}</td>
    <td class="r c-total"><b>${fmtNum(l.total)}</b></td>
    <td class="r"><button class="xbtn" data-action="item-remove" title="Odebrat položku" aria-label="Odebrat">×</button></td>
  </tr>`;
}
function totalsHtml() {
  const t = calc(draft.items);
  const n = t.lines.length, ks = t.lines.reduce((s, l) => s + num(l.qty), 0);
  return `<div class="tot-row"><span>Položek</span><span>${n} (celkem ${fmtNum(ks, 0)} ks)</span></div>
    <div class="tot-row"><span>Základ bez DPH</span><span>${kc(t.base)}</span></div>
    ${Object.entries(t.rates).map(([r, v]) => `<div class="tot-row"><span>DPH ${r} %</span><span>${kc(v.vat)}</span></div>`).join('')}
    ${t.rounding ? `<div class="tot-row"><span>Zaokrouhlení</span><span>${kc(t.rounding)}</span></div>` : ''}
    <div class="tot-big"><span>K úhradě</span><strong>${kc(t.pay)}</strong></div>`;
}
function refreshRow(tr) {
  const it = draft.items[+tr.dataset.i], l = lineCalc(it);
  $('.c-base', tr).textContent = fmtNum(l.base);
  $('.c-total', tr).innerHTML = '<b>' + fmtNum(l.total) + '</b>';
  tr.classList.toggle('zero', !(num(it.qty) > 0));
  $('#totals').innerHTML = totalsHtml();
  storeDraft();
}
function bindEditor() {
  const d = draft;
  const on = (id, ev, fn) => { const el = $('#' + id); if (el) el.addEventListener(ev, fn); };
  on('fCustomer', 'change', e => {
    d.customerId = e.target.value;
    const c = custById(d.customerId);
    if (c && !d.id) {
      if (!d.items.length) loadTemplate(d);
      else repriceItems(c);
    }
    storeDraft(); renderEditor();
  });
  on('fNumber', 'input', e => { d.number = e.target.value.trim(); $('#fVs').value = d.number; storeDraft(); });
  on('fIssued', 'change', e => {
    d.issued = e.target.value; d.duzp = d.issued; d.due = addDays(d.issued, db.settings.dueDays);
    $('#fDuzp').value = d.duzp; $('#fDue').value = d.due; storeDraft();
  });
  on('fDuzp', 'change', e => { d.duzp = e.target.value; storeDraft(); });
  on('fDue', 'change', e => { d.due = e.target.value; storeDraft(); });
  on('fPayment', 'change', e => { d.payment = e.target.value; storeDraft(); });
  on('fNote', 'input', e => { d.note = e.target.value; storeDraft(); });

  const tb = $('.items tbody');
  if (tb) {
    tb.addEventListener('input', e => {
      const inp = e.target.closest('input[data-f]'); if (!inp) return;
      const tr = inp.closest('tr'); const it = d.items[+tr.dataset.i];
      it[inp.dataset.f] = inp.dataset.f === 'qty' ? inp.value : num(inp.value);
      refreshRow(tr);
    });
    tb.addEventListener('focusin', e => { if (e.target.matches('input')) e.target.select(); });
    tb.addEventListener('focusout', e => {
      const inp = e.target.closest('input[data-f]'); if (!inp) return;
      const it = d.items[+inp.closest('tr').dataset.i];
      if (inp.dataset.f === 'price') inp.value = fmtNum(num(it.price));
      else { it.qty = num(it.qty); inp.value = it.qty; }
    });
    tb.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const inp = e.target.closest('input[data-f]'); if (!inp) return;
      e.preventDefault();
      const rows = $$('tr', tb); const idx = rows.indexOf(inp.closest('tr'));
      const nxt = rows[idx + (e.key === 'ArrowUp' ? -1 : 1)];
      if (nxt) $(`input[data-f="${inp.dataset.f}"]`, nxt).focus(); else if (e.key === 'Enter') $('#addSearch').focus();
    });
  }
  bindAddSearch();
}
function repriceItems(c) {
  draft.items.forEach(it => { const p = prodById(it.productId); if (p) { const pr = priceFor(p, c.pricelist); if (pr != null) it.price = pr; } });
}
function bindAddSearch() {
  const inp = $('#addSearch'), list = $('#addList'); if (!inp) return;
  let hits = [], sel = 0;
  const c = custById(draft.customerId);
  const show = () => {
    const q = norm(inp.value).trim();
    if (!q) { list.hidden = true; return; }
    const words = q.split(/\s+/);
    hits = db.products.filter(p => { const h = norm(p.name + ' ' + p.weight); return words.every(w => h.includes(w)); })
      .sort((a, b) => (norm(a.name).startsWith(words[0]) ? 0 : 1) - (norm(b.name).startsWith(words[0]) ? 0 : 1) || sortCz(a.name, b.name)).slice(0, 12);
    sel = 0;
    list.innerHTML = hits.length ? hits.map((p, i) => {
      const pr = priceFor(p, c.pricelist); const inList = draft.items.some(it => it.productId === p.id);
      return `<button class="add-hit ${i === sel ? 'sel' : ''}" data-pid="${esc(p.id)}"><span class="ah-name">${esc(p.name)}</span><span class="ah-w">${esc(p.weight)}</span><span class="ah-p">${pr != null ? kc(pr) : 'bez ceny'}</span>${inList ? '<span class="ah-in">už na faktuře</span>' : ''}</button>`;
    }).join('') : `<div class="add-none">Nic nenalezeno. Nové koření přidáte v části Ceníky.</div>`;
    list.hidden = false;
  };
  const mark = () => $$('.add-hit', list).forEach((b, i) => b.classList.toggle('sel', i === sel));
  inp.addEventListener('input', show);
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (hits[sel]) addProduct(hits[sel].id); }
    else if (e.key === 'Escape') { list.hidden = true; }
  });
  list.addEventListener('mousedown', e => { const b = e.target.closest('.add-hit'); if (b) { e.preventDefault(); addProduct(b.dataset.pid); } });
  inp.addEventListener('blur', () => setTimeout(() => list.hidden = true, 150));
}
function addProduct(pid) {
  const p = prodById(pid), c = custById(draft.customerId);
  let idx = draft.items.findIndex(it => it.productId === pid);
  if (idx < 0) {
    const pr = priceFor(p, c.pricelist);
    draft.items.push({ productId: p.id, name: p.name, weight: p.weight, qty: 1, price: pr != null ? pr : 0, vat: p.vat });
    idx = draft.items.length - 1;
    if (pr == null) toast(`${p.name} nemá v ceníku cenu – doplňte ji ručně.`, true);
  }
  storeDraft(); renderEditor();
  const q = $(`tr[data-i="${idx}"] .in-qty`); if (q) { q.focus(); q.select(); q.closest('tr').scrollIntoView({ block: 'nearest' }); }
}

function validateDraft() {
  const d = draft;
  if (!d.customerId) return 'Vyberte odběratele.';
  if (!d.number) return 'Vyplňte číslo faktury.';
  if (db.invoices.some(i => i.number === d.number && i.id !== d.id)) return `Faktura číslo ${d.number} už existuje. Změňte číslo.`;
  if (!calc(d.items).lines.length) return 'Faktura nemá žádnou položku s počtem větším než 0.';
  if (!d.issued || !d.due) return 'Vyplňte data.';
  return null;
}
function saveDraft(show) {
  const err = validateDraft(); if (err) { toast(err, true); return; }
  const d = draft, c = custById(d.customerId);
  const inv = {
    id: d.id || uid('inv'), number: d.number, vs: d.number, ks: d.ks ?? db.settings.ks, customerId: d.customerId,
    customer: { ...c }, supplier: { ...db.settings.supplier },
    issued: d.issued, duzp: d.duzp, due: d.due, payment: d.payment, note: d.note,
    items: d.items.filter(i => num(i.qty) > 0).map(i => ({ productId: i.productId, name: i.name, weight: i.weight, qty: num(i.qty), price: num(i.price), vat: num(i.vat) })),
    paid: false, createdAt: new Date().toISOString()
  };
  const old = db.invoices.findIndex(i => i.id === inv.id);
  if (old >= 0) { inv.paid = db.invoices[old].paid; inv.createdAt = db.invoices[old].createdAt; db.invoices[old] = inv; }
  else db.invoices.push(inv);
  save(); clearDraft();
  toast(`Faktura ${inv.number} uložena`);
  if (show) openPreview(inv.id); else go('faktury');
}

/* ---------- seznam faktur ---------- */
let invFilter = { customer: '', year: String(new Date().getFullYear()) };
function renderInvoices() {
  const years = [...new Set(db.invoices.map(i => i.issued.slice(0, 4)))].sort().reverse();
  if (!years.includes(invFilter.year)) invFilter.year = years[0] || '';
  const list = db.invoices.filter(i => (!invFilter.customer || i.customerId === invFilter.customer) && (!invFilter.year || i.issued.startsWith(invFilter.year)))
    .sort((a, b) => (b.issued + b.number).localeCompare(a.issued + a.number));
  const t = today();
  const sum = list.reduce((s, i) => s + calc(i.items).pay, 0);
  const unpaid = list.filter(i => !i.paid).reduce((s, i) => s + calc(i.items).pay, 0);
  $('#main').innerHTML = `
  <header class="page-head"><h1>Vystavené faktury</h1>
    <div class="head-actions"><button class="btn btn-primary" data-action="new-invoice">Nová faktura</button></div></header>
  <section class="panel">
    <div class="filters">
      <label class="field"><span>Odběratel</span><select id="flCust"><option value="">Všichni</option>${db.customers.slice().sort((a, b) => sortCz(a.name, b.name)).map(c => `<option value="${esc(c.id)}" ${c.id === invFilter.customer ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Rok</span><select id="flYear"><option value="">Všechny</option>${years.map(y => `<option ${y === invFilter.year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <div class="sum-box"><span>Celkem za výběr</span><b>${kc(sum)}</b></div>
      <div class="sum-box ${unpaid ? 'sum-warn' : ''}"><span>Nezaplaceno</span><b>${kc(unpaid)}</b></div>
    </div>
    ${list.length ? `<table class="list">
      <thead><tr><th>Číslo</th><th>Odběratel</th><th>Vystaveno</th><th>Splatnost</th><th class="r">K úhradě</th><th>Stav</th><th></th></tr></thead>
      <tbody>${list.map(i => {
    const late = !i.paid && i.due < t;
    const cust = i.customer || custById(i.customerId) || {};
    return `<tr data-id="${esc(i.id)}">
          <td><b>${esc(i.number)}</b></td><td>${esc(cust.name)}</td><td>${fmtDate(i.issued)}</td><td>${fmtDate(i.due)}</td>
          <td class="r"><b>${kc(calc(i.items).pay)}</b></td>
          <td><button class="pill ${i.paid ? 'pill-ok' : late ? 'pill-late' : 'pill-open'}" data-action="toggle-paid" title="Kliknutím změníte stav">${i.paid ? 'Zaplaceno' : late ? 'Po splatnosti' : 'Čeká na platbu'}</button></td>
          <td class="row-actions">
            <button class="btn btn-small" data-action="inv-show">Zobrazit / tisk</button>
            <button class="btn btn-small" data-action="inv-edit">Upravit</button>
            <button class="btn btn-small" data-action="inv-copy">Nová podle této</button>
            <button class="xbtn" data-action="inv-delete" title="Smazat fakturu" aria-label="Smazat">×</button>
          </td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Žádné faktury pro tento výběr.</div>'}
  </section>`;
  $('#flCust').onchange = e => { invFilter.customer = e.target.value; renderInvoices(); };
  $('#flYear').onchange = e => { invFilter.year = e.target.value; renderInvoices(); };
}

/* ---------- odběratelé ---------- */
let custSel = null;
function renderCustomers() {
  const list = db.customers.slice().sort((a, b) => sortCz(a.name, b.name));
  if (custSel !== 'new' && !custById(custSel)) custSel = list[0] ? list[0].id : 'new';
  const c = custSel === 'new' ? { id: '', name: '', street: '', city: '', ico: '', dic: '', phone: '', email: '', pricelist: db.pricelists[0].id, note: '' } : custById(custSel);
  const cnt = c.id ? db.invoices.filter(i => i.customerId === c.id).length : 0;
  $('#main').innerHTML = `
  <header class="page-head"><h1>Odběratelé</h1>
    <div class="head-actions"><button class="btn btn-primary" data-action="cust-new">Přidat odběratele</button></div></header>
  <div class="split">
    <section class="panel list-panel">
      ${list.map(x => `<button class="cust-item ${x.id === custSel ? 'active' : ''}" data-action="cust-pick" data-id="${esc(x.id)}"><b>${esc(x.name)}</b><span>${esc([x.city, plName(x.pricelist)].filter(Boolean).join(', '))}</span></button>`).join('') || '<div class="empty">Zatím žádní odběratelé.</div>'}
    </section>
    <section class="panel">
      <h2>${c.id ? esc(c.name) : 'Nový odběratel'}</h2>
      <form id="custForm" class="form-grid" autocomplete="off">
        <label class="field span2"><span>Jméno nebo název firmy</span><input name="name" value="${esc(c.name)}" required></label>
        <label class="field"><span>IČ</span><div class="with-btn"><input name="ico" value="${esc(c.ico)}" inputmode="numeric"><button type="button" class="btn btn-small" data-action="ares">Doplnit z ARES</button></div></label>
        <label class="field"><span>DIČ</span><input name="dic" value="${esc(c.dic)}"></label>
        <label class="field"><span>Ulice a číslo</span><input name="street" value="${esc(c.street)}"></label>
        <label class="field"><span>PSČ a obec</span><input name="city" value="${esc(c.city)}" placeholder="např. 504 01 Nový Bydžov"></label>
        <label class="field"><span>Telefon</span><input name="phone" value="${esc(c.phone)}"></label>
        <label class="field"><span>E-mail</span><input name="email" value="${esc(c.email)}"></label>
        <label class="field span2"><span>Podle jakého ceníku fakturovat</span><select name="pricelist">${db.pricelists.map(p => `<option value="${esc(p.id)}" ${p.id === c.pricelist ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        <label class="field span2"><span>Poznámka (jen pro vás, na faktuře není)</span><input name="note" value="${esc(c.note)}"></label>
        <div class="form-actions span2">
          <button class="btn btn-primary btn-lg" type="submit">Uložit odběratele</button>
          ${c.id ? `<button type="button" class="btn btn-lg" data-action="cust-invoice">Nová faktura pro ${esc(c.name)}</button>` : ''}
          ${c.id ? '<button type="button" class="btn btn-ghost" data-action="cust-delete">Smazat odběratele</button>' : ''}
        </div>
        ${cnt ? `<p class="hint span2">Vystavených faktur: ${cnt}. Změny se projeví jen na nových fakturách.</p>` : ''}
      </form>
    </section>
  </div>`;
  $('#custForm').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.name.trim()) { toast('Vyplňte jméno odběratele.', true); return; }
    if (c.id) Object.assign(c, f); else { const n = { id: uid('c'), ...f }; db.customers.push(n); custSel = n.id; }
    save(); toast('Odběratel uložen'); renderCustomers();
  };
}
async function aresLookup() {
  const form = $('#custForm'); const ico = form.ico.value.replace(/\D/g, '');
  if (ico.length < 6) { toast('Nejdřív napište IČ.', true); return; }
  try {
    const r = await fetch('https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + ico.padStart(8, '0'));
    if (!r.ok) throw new Error(r.status);
    const j = await r.json(); const s = j.sidlo || {};
    form.elements['name'].value = j.obchodniJmeno || form.elements['name'].value;
    if (j.dic) form.dic.value = j.dic;
    const street = [s.nazevUlice || s.nazevObce, [s.cisloDomovni, s.cisloOrientacni].filter(Boolean).join('/')].filter(Boolean).join(' ');
    if (street) form.street.value = street;
    if (s.psc) form.city.value = String(s.psc).replace(/(\d{3})(\d{2})/, '$1 $2') + ' ' + (s.nazevObce || '');
    toast('Údaje doplněny z ARES – zkontrolujte je a uložte.');
  } catch { toast('ARES teď nejde načíst. Údaje vyplňte ručně.', true); }
}

/* ---------- ceníky ---------- */
let plSearch = '';
let plNew = false;
function newPlPanelHtml() {
  const def = db.pricelists.find(p => norm(p.name).includes('maloobchod')) || db.pricelists[0];
  return `<section class="panel import-panel">
    <h2>Nový ceník</h2>
    <div class="form-grid newpl">
      <label class="field span2"><span>Název nového ceníku</span><input id="npName" placeholder="např. Ceník 5 % sleva nebo Ceník Novák"></label>
      <label class="field"><span>Ceny převzít z ceníku</span><select id="npFrom"><option value="">— nic, vyplním ručně —</option>${db.pricelists.map(p => `<option value="${esc(p.id)}" ${p === def ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Sleva v %</span><input id="npDisc" value="0" inputmode="decimal"></label>
      <p class="hint span2" id="npHint"></p>
      <div class="form-actions span2"><button class="btn btn-primary btn-lg" data-action="pl-new-run">Vytvořit ceník</button><button class="btn btn-ghost" data-action="pl-new-cancel">Zrušit</button></div>
    </div>
  </section>`;
}
function newPlHint() {
  const h = $('#npHint'); if (!h) return;
  const from = $('#npFrom').value, d = num($('#npDisc').value);
  const ex = from && db.products.find(p => p.prices[from] != null && p.prices[from] !== '');
  h.textContent = ex ? `Příklad: ${ex.name} ${ex.weight} – ${fmtNum(num(ex.prices[from]))} Kč bez DPH → po slevě ${fmtNum(r2(num(ex.prices[from]) * (1 - d / 100)))} Kč bez DPH (s DPH ${fmtNum(r2(r2(num(ex.prices[from]) * (1 - d / 100)) * (1 + ex.vat / 100)))} Kč).` : '';
}
let plImport = null; // { file, rows: [{name, weight, section, price}] }
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const sep = lines[0].includes(';') ? ';' : ',';
  const split = l => { const out = []; let cur = '', q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out.map(x => x.trim()); };
  const head = split(lines[0]).map(norm);
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const iName = col('nazev'), iW = col('baleni', 'obsah', 'hmotnost'), iS = col('skupina'),
    iNet = col('bez dph'), iGross = head.findIndex(h => h.includes('s dph') || h.includes('vcetne dph')), iVat = col('dph %', 'sazba');
  if (iName < 0) return null;
  return lines.slice(1).map(split).map(c => {
    const vat = iVat >= 0 && c[iVat] ? num(c[iVat]) : 12;
    let price = iNet >= 0 && c[iNet] ? r2(num(c[iNet])) : null;
    if (price == null && iGross >= 0 && c[iGross]) price = r2(num(c[iGross]) / (1 + vat / 100));
    return { name: c[iName], weight: iW >= 0 ? (c[iW] || '').replace(/\s+/g, '') : '', section: iS >= 0 ? c[iS] : '', vat, price };
  }).filter(r => r.name && r.price != null);
}
const prodKey = (name, weight) => norm(name).replace(/[^a-z0-9]/g, '') + '|' + norm(weight).replace(/\s/g, '');
function importStats() {
  const keys = new Set(db.products.map(p => prodKey(p.name, p.weight)));
  const known = plImport.rows.filter(r => keys.has(prodKey(r.name, r.weight))).length;
  return { known, fresh: plImport.rows.length - known };
}
function importPanelHtml() {
  const st = importStats();
  return `<section class="panel import-panel">
    <h2>Nahrát ceník ze souboru</h2>
    <p>Soubor <b>${esc(plImport.file)}</b>: ${plImport.rows.length} položek. ${st.known} koření už v appce je – cena se jim přepíše. ${st.fresh} koření je nových – přidají se a v ostatních cenících zůstanou prázdná.</p>
    <div class="filters">
      <label class="field"><span>Nahrát ceny do ceníku</span><select id="impTarget">${db.pricelists.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="form-actions"><button class="btn btn-primary btn-lg" data-action="pl-import-run">Nahrát ceny</button><button class="btn btn-ghost" data-action="pl-import-cancel">Zrušit</button></div>
    </div>
  </section>`;
}
function runImport(target) {
  const map = new Map(db.products.map(p => [prodKey(p.name, p.weight), p]));
  let upd = 0, add = 0;
  for (const r of plImport.rows) {
    const p = map.get(prodKey(r.name, r.weight));
    if (p) { p.prices[target] = r.price; upd++; }
    else {
      const n = { id: uid('p'), name: r.name, weight: r.weight, section: r.section || 'Koření', vat: r.vat, prices: { [target]: r.price } };
      db.products.push(n); map.set(prodKey(n.name, n.weight), n); add++;
    }
  }
  plImport = null; save();
  toast(`Hotovo: ${upd} cen přepsáno, ${add} nových koření přidáno do ${plName(target)}`);
  renderPricelist();
}
function renderPricelist() {
  const q = norm(plSearch).trim().split(/\s+/).filter(Boolean);
  const prods = db.products.filter(p => !q.length || q.every(w => norm(p.name + ' ' + p.weight + ' ' + p.section).includes(w)));
  const sections = [...new Set(db.products.map(p => p.section || 'Ostatní'))];
  $('#main').innerHTML = `
  <header class="page-head"><h1>Ceníky</h1>
    <div class="head-actions"><label class="btn">Nahrát ceník ze souboru<input type="file" accept=".csv,text/csv" data-action="pl-import-file" hidden></label><button class="btn" data-action="pl-add">Přidat ceník</button><button class="btn btn-primary" data-action="prod-add">Přidat koření</button></div></header>
  ${plImport ? importPanelHtml() : ''}
  ${plNew ? newPlPanelHtml() : ''}
  <section class="panel">
    <p class="hint">Ceny jsou <b>za kus bez DPH</b>. Změny se ukládají hned. Odběratel dostane ceny ze svého ceníku; když tam cena chybí, použije se základní ceník.</p>
    <div class="pl-names">${db.pricelists.map(p => `<span class="pl-chip">${esc(p.name)} <button class="link" data-action="pl-rename" data-id="${esc(p.id)}">přejmenovat</button>${p.id !== 'zakladni' ? ` <button class="link" data-action="pl-delete" data-id="${esc(p.id)}">smazat</button>` : ''}</span>`).join('')}</div>
    <input id="plSearch" class="add-search" type="search" placeholder="Hledat v ceníku…" value="${esc(plSearch)}">
    <datalist id="sections">${sections.map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    <table class="items pl-table">
      <thead><tr><th>Název</th><th>Balení</th><th>Skupina</th><th class="r">DPH %</th>${db.pricelists.map(p => `<th class="r">${esc(p.name)}</th>`).join('')}<th></th></tr></thead>
      <tbody id="plBody">${prods.map(p => `<tr data-id="${esc(p.id)}">
        <td><input data-f="name" value="${esc(p.name)}"></td>
        <td><input data-f="weight" value="${esc(p.weight)}" class="in-w"></td>
        <td><input data-f="section" value="${esc(p.section)}" list="sections" class="in-sec"></td>
        <td class="r"><input data-f="vat" value="${esc(p.vat)}" class="in-vat" inputmode="numeric"></td>
        ${db.pricelists.map(pl => `<td class="r"><input data-pl="${esc(pl.id)}" class="in-price" value="${p.prices[pl.id] != null && p.prices[pl.id] !== '' ? esc(fmtNum(num(p.prices[pl.id]))) : ''}" placeholder="—" inputmode="decimal"></td>`).join('')}
        <td class="r"><button class="xbtn" data-action="prod-delete" title="Smazat koření" aria-label="Smazat">×</button></td>
      </tr>`).join('')}</tbody>
    </table>
    ${prods.length ? '' : '<div class="empty">Nic nenalezeno.</div>'}
  </section>`;
  const s = $('#plSearch');
  s.oninput = () => { plSearch = s.value; const pos = s.selectionStart; renderPricelist(); const n = $('#plSearch'); n.focus(); n.setSelectionRange(pos, pos); };
  if (plNew) { $('#npFrom').onchange = newPlHint; $('#npDisc').oninput = newPlHint; newPlHint(); }
  $('#plBody').addEventListener('change', e => {
    const inp = e.target; const p = prodById(inp.closest('tr').dataset.id); if (!p) return;
    if (inp.dataset.pl) { p.prices[inp.dataset.pl] = inp.value.trim() === '' ? null : r2(num(inp.value)); if (inp.value.trim()) inp.value = fmtNum(num(inp.value)); }
    else if (inp.dataset.f === 'vat') p.vat = num(inp.value);
    else p[inp.dataset.f] = inp.value.trim();
    save(); toast('Uloženo');
  });
}

/* ---------- nastavení ---------- */
function renderSettings() {
  const s = db.settings, sp = s.supplier; const iban = toIBAN(sp.account);
  $('#main').innerHTML = `
  <header class="page-head"><h1>Nastavení a záloha</h1></header>
  <div class="split split-even">
    <section class="panel">
      <h2>Dodavatel (vy)</h2>
      <form id="setForm" class="form-grid" autocomplete="off">
        <label class="field span2"><span>Název značky (nahoře na faktuře)</span><input name="brand" value="${esc(s.brand)}"></label>
        <label class="field span2"><span>Jméno dodavatele</span><input name="sp.name" value="${esc(sp.name)}"></label>
        <label class="field"><span>Ulice a číslo</span><input name="sp.street" value="${esc(sp.street)}"></label>
        <label class="field"><span>PSČ a obec</span><input name="sp.city" value="${esc(sp.city)}"></label>
        <label class="field"><span>IČ</span><input name="sp.ico" value="${esc(sp.ico)}"></label>
        <label class="field"><span>DIČ</span><input name="sp.dic" value="${esc(sp.dic)}"></label>
        <label class="field"><span>Banka</span><input name="sp.bank" value="${esc(sp.bank)}"></label>
        <label class="field"><span>Číslo účtu</span><input name="sp.account" value="${esc(sp.account)}" placeholder="123456789/0300"></label>
        <label class="field"><span>Telefon</span><input name="sp.phone" value="${esc(sp.phone)}"></label>
        <label class="field"><span>E-mail</span><input name="sp.email" value="${esc(sp.email)}"></label>
        <p class="hint span2">${iban ? 'IBAN pro QR platbu: ' + iban.replace(/(.{4})/g, '$1 ') : 'Číslo účtu zadejte ve tvaru 123456789/0300 – pak se na faktuře objeví QR platba.'}</p>
        <h2 class="span2">Faktura</h2>
        <label class="field"><span>Splatnost (dní)</span><input name="dueDays" value="${esc(s.dueDays)}" inputmode="numeric"></label>
        <label class="field"><span>Konstantní symbol</span><input name="ks" value="${esc(s.ks)}"></label>
        <label class="field"><span>Výchozí forma úhrady</span><select name="payment">${['Převodem', 'Hotově'].map(p => `<option ${p === s.payment ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <label class="field"><span>Zaokrouhlit na celé koruny</span><select name="roundTotal"><option value="1" ${s.roundTotal ? 'selected' : ''}>Ano</option><option value="0" ${s.roundTotal ? '' : 'selected'}>Ne</option></select></label>
        <label class="field"><span>Fakturu vystavil(a)</span><input name="issuer" value="${esc(s.issuer)}"></label>
        <label class="field"><span>Text pod fakturou</span><input name="note" value="${esc(s.note)}"></label>
        <div class="form-actions span2"><button class="btn btn-primary btn-lg" type="submit">Uložit nastavení</button></div>
      </form>
    </section>
    <section class="panel">
      <h2>Záloha</h2>
      <p>Všechno se ukládá jen v tomto prohlížeči na tomto počítači. Když se smaže historie prohlížeče, data zmizí. Proto si <b>jednou za dva týdny stáhněte zálohu</b> a uložte ji třeba na flashku.</p>
      <p class="hint">${db.lastBackup ? 'Poslední záloha: ' + fmtDate(db.lastBackup.slice(0, 10)) : 'Zatím jste zálohu nestahovali.'}</p>
      <div class="form-actions">
        <button class="btn btn-primary btn-lg" data-action="backup">Stáhnout zálohu</button>
        <label class="btn btn-lg">Obnovit ze zálohy<input type="file" accept=".json,application/json" data-action="import-file" hidden></label>
      </div>
      <p class="hint">Obnovení ze zálohy nahradí všechna současná data.</p>
      <h2>Přehled</h2>
      <p>Faktur: <b>${db.invoices.length}</b> &nbsp; Odběratelů: <b>${db.customers.length}</b> &nbsp; Druhů koření: <b>${db.products.length}</b></p>
    </section>
  </div>`;
  $('#setForm').onsubmit = e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    for (const [k, v] of Object.entries(f)) {
      if (k.startsWith('sp.')) sp[k.slice(3)] = v.trim();
      else if (k === 'dueDays') s.dueDays = Math.max(0, Math.round(num(v)));
      else if (k === 'roundTotal') s.roundTotal = v === '1';
      else s[k] = v.trim();
    }
    save(); toast('Nastavení uloženo'); render();
  };
}

/* ---------- záloha ---------- */
function downloadBackup() {
  db.lastBackup = new Date().toISOString(); save();
  const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `faktury-zaloha-${today()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Záloha stažena do složky Stažené soubory'); render();
}
function importFile(file) {
  const r = new FileReader();
  r.onload = () => {
    let d; try { d = JSON.parse(r.result); } catch { toast('Tohle není soubor se zálohou.', true); return; }
    if (!d || !d.settings || !Array.isArray(d.products)) { toast('Tohle není soubor se zálohou.', true); return; }
    if (db && db.invoices.length && !confirm('Opravdu nahradit všechna současná data daty ze souboru?')) return;
    db = fixDb(d); save(); clearDraft(); toast('Data načtena'); go('nova');
  };
  r.readAsText(file);
}

/* ---------- faktura k tisku ---------- */
let previewId = null;
function openPreview(id) {
  previewId = id;
  const inv = db.invoices.find(i => i.id === id);
  $('#printArea').innerHTML = invoiceHtml(inv);
  $('#preview').hidden = false; document.body.classList.add('no-scroll');
}
function closePreview() { $('#preview').hidden = true; document.body.classList.remove('no-scroll'); }
function invoiceHtml(inv) {
  const sp = inv.supplier || db.settings.supplier;
  const cu = inv.customer || custById(inv.customerId) || {};
  const t = calc(inv.items);
  const qr = qrSvg(inv, t.pay);
  const brand = db.settings.brand;
  const lines = (a) => a.filter(Boolean).map(x => `<div>${esc(x)}</div>`).join('');
  return `<article class="inv">
    <header class="inv-head">
      <div class="inv-brand">
        <div class="inv-brand-name">${esc(brand)}</div>
        ${sp.phone || sp.email ? `<div class="inv-brand-sub">${esc([sp.phone && 'tel. ' + sp.phone, sp.email].filter(Boolean).join('   '))}</div>` : ''}
      </div>
      <div class="inv-title">
        <div class="inv-kind">Faktura – daňový doklad</div>
        <div class="inv-no">č. ${esc(inv.number)}</div>
      </div>
    </header>

    <section class="inv-parties">
      <div class="inv-party">
        <div class="inv-lbl">Dodavatel</div>
        <div class="inv-pname">${esc(sp.name)}</div>
        ${lines([sp.street, sp.city])}
        <div class="inv-ids">${sp.ico ? `IČ: ${esc(sp.ico)}` : ''}${sp.dic ? `<br>DIČ: ${esc(sp.dic)}` : ''}</div>
      </div>
      <div class="inv-party inv-buyer">
        <div class="inv-lbl">Odběratel</div>
        <div class="inv-pname">${esc(cu.name)}</div>
        ${lines([cu.street, cu.city])}
        <div class="inv-ids">${cu.ico ? `IČ: ${esc(cu.ico)}` : ''}${cu.dic ? `<br>DIČ: ${esc(cu.dic)}` : ''}</div>
      </div>
    </section>

    <section class="inv-meta">
      <div><span>Datum vystavení</span><b>${fmtDate(inv.issued)}</b></div>
      <div><span>Datum uskut. zdan. plnění</span><b>${fmtDate(inv.duzp)}</b></div>
      <div><span>Datum splatnosti</span><b>${fmtDate(inv.due)}</b></div>
      <div><span>Forma úhrady</span><b>${esc(inv.payment)}</b></div>
      <div><span>Banka / číslo účtu</span><b>${esc([sp.bank, sp.account].filter(Boolean).join(' – '))}</b></div>
      <div><span>Variabilní symbol</span><b>${esc(inv.vs || inv.number)}</b></div>
      ${inv.ks ? `<div><span>Konstantní symbol</span><b>${esc(inv.ks)}</b></div>` : ''}
    </section>

    <table class="inv-items">
      <thead><tr><th>Položka</th><th>Balení</th><th class="r">Počet ks</th><th class="r">Cena/ks<br>bez DPH</th><th class="r">Sazba</th><th class="r">Základ</th><th class="r">DPH</th><th class="r">Celkem<br>s DPH</th></tr></thead>
      <tbody>${t.lines.map(l => `<tr><td>${esc(l.name)}</td><td>${esc(l.weight)}</td><td class="r">${fmtNum(l.qty, Number.isInteger(l.qty) ? 0 : 2)}</td><td class="r">${fmtNum(l.price)}</td><td class="r">${esc(l.vat)} %</td><td class="r">${fmtNum(l.base)}</td><td class="r">${fmtNum(l.vatAmt)}</td><td class="r"><b>${fmtNum(l.total)}</b></td></tr>`).join('')}</tbody>
    </table>

    <section class="inv-bottom">
      <div class="inv-qr">${qr ? `${qr}<div class="inv-qr-lbl">QR platba</div>` : ''}</div>
      <table class="inv-recap">
        <thead><tr><th>Sazba DPH</th><th class="r">Základ</th><th class="r">DPH</th><th class="r">Celkem</th></tr></thead>
        <tbody>${Object.entries(t.rates).map(([r, v]) => `<tr><td>${r} %</td><td class="r">${fmtNum(v.base)}</td><td class="r">${fmtNum(v.vat)}</td><td class="r">${fmtNum(r2(v.base + v.vat))}</td></tr>`).join('')}
        <tr class="sum"><td>Celkem</td><td class="r">${fmtNum(t.base)}</td><td class="r">${fmtNum(t.vat)}</td><td class="r">${fmtNum(t.total)}</td></tr>
        ${t.rounding ? `<tr><td colspan="3">Zaokrouhlení</td><td class="r">${fmtNum(t.rounding)}</td></tr>` : ''}</tbody>
      </table>
      <div class="inv-pay">
        <span>K úhradě</span>
        <strong>${fmtNum(t.pay, t.rounding || Number.isInteger(t.pay) ? 0 : 2)} Kč</strong>
        <em>splatné do ${fmtDate(inv.due)}</em>
      </div>
    </section>

    ${inv.note ? `<p class="inv-note">${esc(inv.note)}</p>` : ''}
    <footer class="inv-foot">
      <span>${esc(db.settings.note)}</span>
      <span>${db.settings.issuer ? 'Vystavil(a): ' + esc(db.settings.issuer) : ''}</span>
    </footer>
  </article>`;
}

/* ---------- akce (tlačítka) ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-action]'); if (!b || b.tagName === 'INPUT') return;
  const a = b.dataset.action;
  const rowId = () => b.closest('tr').dataset.id;
  const inv = () => db.invoices.find(i => i.id === rowId());
  switch (a) {
    case 'start-empty': db = emptyDb(); save(); go('nastaveni'); break;
    case 'backup': downloadBackup(); break;
    case 'new-invoice': clearDraft(); go('nova'); break;
    case 'draft-discard':
      if (draft && (draft.items.length || draft.id) && !confirm(draft.id ? 'Zahodit změny ve faktuře?' : 'Zahodit rozpracovanou fakturu?')) return;
      clearDraft(); renderEditor(); break;
    case 'go-customers-new': custSel = 'new'; go('odberatele'); break;
    case 'load-last':
      if (draft.items.length && !confirm('Nahradit současné položky položkami z minulé faktury?')) return;
      loadTemplate(draft); storeDraft(); renderEditor(); toast('Položky načteny – upravte počty kusů'); break;
    case 'zero-qty': draft.items.forEach(i => i.qty = 0); storeDraft(); renderEditor(); { const q = $('.in-qty'); if (q) q.focus(); } break;
    case 'reprice': repriceItems(custById(draft.customerId)); storeDraft(); renderEditor(); toast('Ceny nastaveny podle ceníku odběratele'); break;
    case 'qty-minus': case 'qty-plus': {
      const tr = b.closest('tr'); const it = draft.items[+tr.dataset.i];
      it.qty = Math.max(0, num(it.qty) + (a === 'qty-plus' ? 1 : -1)); $('.in-qty', tr).value = it.qty; refreshRow(tr); break;
    }
    case 'item-remove': draft.items.splice(+b.closest('tr').dataset.i, 1); storeDraft(); renderEditor(); break;
    case 'save': saveDraft(false); break;
    case 'save-print': saveDraft(true); break;
    case 'toggle-paid': { const i = inv(); i.paid = !i.paid; save(); renderInvoices(); break; }
    case 'inv-show': openPreview(rowId()); break;
    case 'inv-edit': case 'preview-edit': {
      const i = a === 'inv-edit' ? inv() : db.invoices.find(x => x.id === previewId);
      draft = JSON.parse(JSON.stringify({ id: i.id, number: i.number, customerId: i.customerId, issued: i.issued, duzp: i.duzp, due: i.due, payment: i.payment, ks: i.ks, items: i.items, note: i.note || '' }));
      storeDraft(); closePreview(); go('nova'); break;
    }
    case 'inv-copy': {
      const i = inv(); draft = newDraft(); draft.customerId = i.customerId;
      const c = custById(i.customerId);
      draft.items = i.items.map(x => ({ ...x })); if (c) repriceItems(c);
      storeDraft(); go('nova'); toast('Položky zkopírovány – upravte počty kusů'); break;
    }
    case 'inv-delete': { const i = inv(); if (!confirm(`Opravdu smazat fakturu ${i.number}? Nejde to vrátit.`)) return; db.invoices = db.invoices.filter(x => x.id !== i.id); save(); renderInvoices(); break; }
    case 'print': {
      const i = db.invoices.find(x => x.id === previewId); const c = i.customer || custById(i.customerId) || {};
      const old = document.title; document.title = `Faktura ${i.number} ${c.name || ''}`.trim();
      window.print(); setTimeout(() => document.title = old, 500); break;
    }
    case 'preview-close': closePreview(); break;
    case 'cust-new': custSel = 'new'; renderCustomers(); $('#custForm').elements['name'].focus(); break;
    case 'cust-pick': custSel = b.dataset.id; renderCustomers(); break;
    case 'cust-invoice': clearDraft(); draft = newDraft(custSel); storeDraft(); go('nova'); break;
    case 'cust-delete': { const c = custById(custSel); const n = db.invoices.filter(i => i.customerId === custSel).length;
      if (!confirm(n ? `Smazat odběratele ${c.name}? Má ${n} vystavených faktur – ty zůstanou uložené a dají se dál tisknout.` : `Smazat odběratele ${c.name}?`)) return;
      db.invoices.forEach(i => { if (i.customerId === c.id && !i.customer) i.customer = { ...c }; }); } db.customers = db.customers.filter(c => c.id !== custSel); custSel = null; save(); renderCustomers(); break;
    case 'ares': aresLookup(); break;
    case 'pl-import-run': runImport($('#impTarget').value); break;
    case 'pl-import-cancel': plImport = null; renderPricelist(); break;
    case 'prod-add': {
      const p = { id: uid('p'), name: 'Nové koření', weight: '100g', section: 'Koření', vat: 12, prices: {} };
      db.products.unshift(p); plSearch = ''; save(); renderPricelist();
      const n = $(`tr[data-id="${p.id}"] input[data-f="name"]`); n.focus(); n.select(); break;
    }
    case 'prod-delete': {
      const p = prodById(rowId()); if (!confirm(`Smazat „${p.name} ${p.weight}“ z ceníku? Staré faktury zůstanou beze změny.`)) return;
      db.products = db.products.filter(x => x.id !== p.id); save(); renderPricelist(); break;
    }
    case 'pl-add': plNew = true; plImport = null; renderPricelist(); window.scrollTo(0, 0); $('#npName').focus(); newPlHint(); break;
    case 'pl-new-cancel': plNew = false; renderPricelist(); break;
    case 'pl-new-run': {
      const name = $('#npName').value.trim(), from = $('#npFrom').value, d = num($('#npDisc').value);
      if (!name) { toast('Napište název nového ceníku.', true); $('#npName').focus(); return; }
      if (d < 0 || d >= 100) { toast('Sleva musí být mezi 0 a 99 %.', true); return; }
      const id = uid('pl'); db.pricelists.push({ id, name }); let n = 0;
      if (from) db.products.forEach(p => { const v = p.prices[from]; if (v != null && v !== '') { p.prices[id] = r2(num(v) * (1 - d / 100)); n++; } });
      plNew = false; save(); renderPricelist();
      toast(from ? `Ceník ${name} vytvořen: ${n} cen${d ? ` se slevou ${fmtNum(d, d % 1 ? 1 : 0)} %` : ''}` : `Ceník ${name} vytvořen – doplňte ceny`);
      break;
    }
    case 'pl-rename': { const pl = db.pricelists.find(p => p.id === b.dataset.id); const n = prompt('Nový název ceníku:', pl.name); if (n) { pl.name = n.trim(); save(); renderPricelist(); } break; }
    case 'pl-delete': {
      const pl = db.pricelists.find(p => p.id === b.dataset.id);
      const used = db.customers.filter(c => c.pricelist === pl.id).map(c => c.name);
      if (used.length) { toast(`Ceník používá: ${used.join(', ')}. Nejdřív jim nastavte jiný.`, true); return; }
      if (!confirm(`Smazat ${pl.name}?`)) return;
      db.pricelists = db.pricelists.filter(p => p.id !== pl.id); db.products.forEach(p => delete p.prices[pl.id]); save(); renderPricelist(); break;
    }
  }
});
document.addEventListener('change', e => {
  if (e.target.matches('input[type=file][data-action="pl-import-file"]') && e.target.files[0]) {
    const f = e.target.files[0]; e.target.value = '';
    const r = new FileReader();
    r.onload = () => {
      const rows = parseCsv(r.result);
      if (!rows || !rows.length) { toast('V souboru jsem nenašel žádné ceny. Potřebuje sloupce Název, Balení a Cena.', true); return; }
      plImport = { file: f.name, rows }; renderPricelist(); window.scrollTo(0, 0);
    };
    r.readAsText(f, 'utf-8');
    return;
  }
  if (e.target.matches('input[type=file][data-action="import-file"]') && e.target.files[0]) { importFile(e.target.files[0]); e.target.value = ''; }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#preview').hidden) closePreview(); });

render();
