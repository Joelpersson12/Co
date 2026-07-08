/* =========================================================
   Moms — enkel momskoll. All data lokalt i webbläsaren.
   ========================================================= */
'use strict';

const STORE_KEY = 'moms.data.v1';
const MONTHS = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];
const VAT_RATES = [25, 12, 6, 0];

/* ---------- State ---------- */
let state = load();
let currentDeadline = null;     // Date of the active period's deadline
let currentDeadlineDays = null; // days left until it

function defaultState() {
  return {
    settings: { name: '', org: '', period: 'kvartal', start: '', deadlineOverride: '', notify: false },
    receipts: [],          // {id, verNr, date, type, party, desc, exkl, vat, total, rate, fileData, note, createdAt}
    calculations: [],      // {id, ts, label, type, amount, inclusive, rate, exkl, vat, total, bookedId}
    notes: '',
    importedIds: {},       // Stripe balance-transaction ids already imported (dedupe)
    checks: {},            // { 'periodKey': [bool x5] }
    activePeriod: null,    // periodKey string, null = current
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const s = Object.assign(defaultState(), JSON.parse(raw));
    // Migration: earlier Stripe fees were booked as plain 0 % — mark them as
    // EU reverse-charge so rutorna 21/30/48 are complete (does not change ruta 49).
    (s.receipts || []).forEach(r => {
      if (r.desc === 'Stripe-avgift' && r.type === 'inkop' && !r.reverse) r.reverse = true;
    });
    return s;
  } catch { return defaultState(); }
}
function save(opts) {
  state.updatedAt = Date.now();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Kunde inte spara — lagringen kan vara full.'); }
  if (!(opts && opts.skipSync)) scheduleSyncPush();
}

/* ---------- Money & VAT helpers ---------- */
const kr = (n) => (Math.round(n) || 0).toLocaleString('sv-SE') + ' kr';
const krSigned = (n) => (n > 0 ? '+' : '') + kr(n);

function computeVat(amount, rate, inclusive) {
  const r = rate / 100;
  if (rate === 0) return { exkl: amount, vat: 0, total: amount };
  if (inclusive === 'inkl') {
    const exkl = amount / (1 + r);
    return { exkl, vat: amount - exkl, total: amount };
  }
  return { exkl: amount, vat: amount * r, total: amount + amount * r };
}

/* ---------- Period logic ----------
   A periodKey identifies a reporting period.
   kvartal: "2026-Q1"  manad: "2026-03"  helar: "2026"
*/
function currentPeriodKey(period, d = new Date()) {
  const y = d.getFullYear();
  if (period === 'manad') return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (period === 'helar') return `${y}`;
  return `${y}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

// Returns {start: Date, end: Date} inclusive range for a periodKey
function periodRange(period, key) {
  if (period === 'manad') {
    const [y, m] = key.split('-').map(Number);
    return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0) };
  }
  if (period === 'helar') {
    const y = Number(key);
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
  }
  const [ys, q] = key.split('-Q');
  const y = Number(ys), qi = Number(q);
  return { start: new Date(y, (qi - 1) * 3, 1), end: new Date(y, qi * 3, 0) };
}

// Skatteverket-style deadline: 12th of 2nd month after period end (yearly: 26th).
// Deadlines falling in Jan or Aug shift to the 17th. Always advisory.
function deadlineFor(period, key) {
  const { end } = periodRange(period, key);
  let dueMonth = end.getMonth() + 2; // 2nd month after period end
  let dueYear = end.getFullYear();
  while (dueMonth > 11) { dueMonth -= 12; dueYear += 1; }
  let day = period === 'helar' ? 26 : 12;
  if (period !== 'helar' && (dueMonth === 0 || dueMonth === 7)) day = 17; // Jan/Aug
  const d = new Date(dueYear, dueMonth, day);
  // If the deadline lands on a weekend it moves to the next weekday.
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function periodLabel(period, key) {
  if (period === 'manad') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }
  if (period === 'helar') return `Helår ${key}`;
  const [y, q] = key.split('-Q');
  return `Kvartal ${q} ${y}`;
}

function activeKey() {
  return state.activePeriod || currentPeriodKey(state.settings.period);
}

// Build a list of selectable periods: a few back, current, and next.
function periodChoices() {
  const period = state.settings.period;
  const keys = [];
  const now = new Date();
  if (period === 'manad') {
    for (let i = -5; i <= 1; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      keys.push(currentPeriodKey('manad', d));
    }
  } else if (period === 'helar') {
    for (let i = -2; i <= 1; i++) keys.push(String(now.getFullYear() + i));
  } else {
    for (let i = -4; i <= 1; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i * 3, 1);
      keys.push(currentPeriodKey('kvartal', d));
    }
  }
  let unique = [...new Set(keys)];
  // Hide periods that ended before the company started.
  if (state.settings.start) {
    const start = new Date(state.settings.start + 'T00:00:00');
    const filtered = unique.filter(k => periodRange(period, k).end >= start);
    if (filtered.length) unique = filtered;
  }
  return unique;
}

/* ---------- Receipts for active period ---------- */
function receiptsInPeriod() {
  const { start, end } = periodRange(state.settings.period, activeKey());
  return state.receipts.filter(r => {
    const d = new Date(r.date + 'T00:00:00');
    return d >= start && d <= end;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- VAT declaration totals ---------- */
function declTotals() {
  const rs = receiptsInPeriod();
  const t = { sales: 0, u25: 0, u12: 0, u6: 0, ing: 0, euServices: 0, reverseVat: 0 };
  for (const r of rs) {
    if (r.type === 'forsaljning') {
      t.sales += r.exkl;
      if (r.rate === 25) t.u25 += r.vat;
      else if (r.rate === 12) t.u12 += r.vat;
      else if (r.rate === 6) t.u6 += r.vat;
    } else if (r.reverse) {
      // EU service purchase (e.g. Stripe fee): buyer self-accounts for VAT.
      t.euServices += r.exkl;         // ruta 21
      const rv = r.exkl * 0.25;       // 25 % förvärvsmoms
      t.reverseVat += rv;             // ruta 30
      t.ing += rv;                    // ruta 48 (avdragsgill)
    } else {
      t.ing += r.vat;
    }
  }
  t.utg = t.u25 + t.u12 + t.u6 + t.reverseVat; // ruta 10+11+12+30
  t.toPay = t.utg - t.ing;                       // ruta 49
  return t;
}

/* =========================================================
   Rendering
   ========================================================= */
function renderAll() {
  renderTopbar();
  renderOverview();
  renderReceiptList();
  renderCalcList();
  renderDeclaration();
  renderSettingsForm();
  document.getElementById('notes').value = state.notes || '';
}

function renderTopbar() {
  document.getElementById('periodLabel').textContent = periodLabel(state.settings.period, activeKey());
  document.getElementById('bizNameTop').textContent = state.settings.name || 'Mitt företag';
  document.getElementById('periodSub').textContent =
    `Din momsredovisning för ${periodLabel(state.settings.period, activeKey()).toLowerCase()}.`;
}

function renderOverview() {
  const t = declTotals();
  const override = state.settings.deadlineOverride;
  const dl = override ? new Date(override + 'T00:00:00') : deadlineFor(state.settings.period, activeKey());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((dl - today) / 86400000);

  document.getElementById('deadlineDate').textContent =
    `${dl.getDate()} ${MONTHS[dl.getMonth()]} ${dl.getFullYear()}`;
  const cd = document.getElementById('deadlineCountdown');
  let txt;
  if (days > 1) txt = `Om ${days} dagar`;
  else if (days === 1) txt = 'I morgon!';
  else if (days === 0) txt = 'Idag!';
  else txt = `${Math.abs(days)} dagar sedan (försenad?)`;
  cd.textContent = txt + (override ? ' · eget datum' : '');

  // Stash for calendar export / notifications.
  currentDeadline = dl;
  currentDeadlineDays = days;

  // Reminder banner: appears when the deadline is close or passed.
  const banner = document.getElementById('reminderBanner');
  const dStr = `${dl.getDate()} ${MONTHS[dl.getMonth()]}`;
  if (days < 0) {
    banner.hidden = false; banner.className = 'reminder-banner late';
    banner.textContent = `Deadline (${dStr}) har passerat. Deklarera så snart du kan.`;
  } else if (days <= 14) {
    banner.hidden = false; banner.className = 'reminder-banner warn';
    banner.textContent = `Snart dags! Bara ${days} ${days === 1 ? 'dag' : 'dagar'} kvar till deadline ${dStr}. Stäm av och deklarera.`;
  } else {
    banner.hidden = true;
  }

  document.getElementById('notifyBtn').classList.toggle('on', !!state.settings.notify);

  document.getElementById('heroAmount').textContent = kr(Math.abs(t.toPay));
  const badge = document.getElementById('heroAmountBadge');
  if (t.toPay > 0) badge.textContent = 'Att betala';
  else if (t.toPay < 0) badge.textContent = 'Att få tillbaka';
  else badge.textContent = 'Noll';

  document.getElementById('sumUtg').textContent = kr(t.utg);
  document.getElementById('sumIng').textContent = kr(t.ing);
  document.getElementById('sumCount').textContent = receiptsInPeriod().length;

  renderChecklist();
}

const CHECK_ITEMS = [
  'Samla alla kvitton för perioden',
  'Kontrollera att momsen stämmer på varje kvitto',
  'Stäm av summorna under Momsdeklaration',
  'Logga in på Skatteverket och fyll i deklarationen',
  'Betala momsen (eller invänta återbetalning)',
];
function renderChecklist() {
  const key = activeKey();
  const checks = state.checks[key] || (state.checks[key] = [false, false, false, false, false]);
  const ul = document.getElementById('checklist');
  ul.innerHTML = '';
  CHECK_ITEMS.forEach((label, i) => {
    const li = document.createElement('li');
    li.className = 'check-item' + (checks[i] ? ' done' : '');
    li.tabIndex = 0;
    li.setAttribute('role', 'checkbox');
    li.setAttribute('aria-checked', checks[i] ? 'true' : 'false');
    li.innerHTML = `<span class="check-box"><svg class="ic"><use href="#i-check"/></svg></span><span class="check-text">${label}</span>`;
    const toggle = () => { checks[i] = !checks[i]; save(); renderChecklist(); };
    li.addEventListener('click', toggle);
    li.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } });
    ul.appendChild(li);
  });
  const done = checks.filter(Boolean).length;
  document.getElementById('checkProgress').textContent = `${done} / 5 klart`;
}

function renderReceiptList() {
  const rs = receiptsInPeriod().slice().reverse();
  const list = document.getElementById('receiptList');
  document.getElementById('receiptCount').textContent = `${rs.length} st`;
  if (!rs.length) {
    list.innerHTML = `<div class="empty">Inga kvitton i ${periodLabel(state.settings.period, activeKey()).toLowerCase()} än.<br>Lägg till ditt första ovan.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const r of rs) {
    const row = document.createElement('div');
    row.className = 'receipt-row';
    const isSale = r.type === 'forsaljning';
    const thumb = r.fileData
      ? `<img class="receipt-thumb" src="${r.fileData}" alt="Kvitto" />`
      : `<span class="receipt-thumb"><svg class="ic"><use href="#i-receipt"/></svg></span>`;
    row.innerHTML = `
      ${thumb}
      <div class="receipt-main">
        <div class="receipt-title">${esc(r.party)} <span class="receipt-tag ${isSale ? 'tag-in' : 'tag-out'}">${isSale ? 'Försäljning' : 'Inköp'}</span></div>
        <div class="receipt-meta"><span>${fmtDate(r.date)}</span><span>${esc(r.desc)}</span><span>${r.reverse ? 'omvänd moms 25 %' : r.rate + '% moms'}</span></div>
      </div>
      <div class="receipt-amt">
        <div class="a">${kr(r.total)}</div>
        <div class="v">moms ${kr(r.vat)}</div>
      </div>
      <button class="receipt-del" aria-label="Ta bort kvitto" data-del="${r.id}"><svg class="ic"><use href="#i-trash"/></svg></button>`;
    row.querySelector('[data-del]').addEventListener('click', () => deleteReceipt(r.id));
    list.appendChild(row);
  }
}

function renderCalcList() {
  const list = document.getElementById('calcList');
  if (!list) return;
  const calcs = state.calculations.slice().reverse();
  document.getElementById('calcCount').textContent = `${calcs.length} st`;
  if (!calcs.length) {
    list.innerHTML = `<div class="empty">Inga sparade uträkningar än.<br>Räkna ut något ovan och tryck Spara.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const c of calcs) {
    const isSale = c.type === 'forsaljning';
    const row = document.createElement('div');
    row.className = 'calc-row';
    const booked = !!c.bookedId;
    row.innerHTML = `
      <div class="calc-row-main">
        <div class="calc-row-title">${esc(c.label)} <span class="receipt-tag ${isSale ? 'tag-in' : 'tag-out'}">${isSale ? 'Försäljning' : 'Inköp'}</span></div>
        <div class="calc-row-meta">${esc(c.date ? fmtDate(c.date) : fmtDateTime(c.ts))} · ${c.rate}% moms · exkl ${kr(c.exkl)}</div>
      </div>
      <div class="calc-row-amt">
        <div class="a">${kr(c.total)}</div>
        <div class="v">moms ${kr(c.vat)}</div>
      </div>
      <button class="calc-book" ${booked ? 'disabled' : ''} data-book="${c.id}">${booked ? 'Bokfört ✓' : 'Gör till kvitto'}</button>
      <button class="receipt-del" aria-label="Ta bort uträkning" data-delcalc="${c.id}"><svg class="ic"><use href="#i-trash"/></svg></button>`;
    row.querySelector('[data-delcalc]').addEventListener('click', () => deleteCalc(c.id));
    if (!booked) row.querySelector('[data-book]').addEventListener('click', () => bookCalc(c.id));
    list.appendChild(row);
  }
}

function deleteCalc(id) {
  state.calculations = state.calculations.filter(c => c.id !== id);
  save(); renderCalcList(); toast('Uträkning borttagen');
}

// Turn a saved calculation into a real receipt so it counts in the declaration.
function bookCalc(id) {
  const c = state.calculations.find(x => x.id === id);
  if (!c || c.bookedId) return;
  const rid = 'r' + Date.now() + Math.random().toString(36).slice(2, 6);
  state.receipts.push({
    id: rid, verNr: nextVerNr(),
    date: c.date || new Date(c.ts).toISOString().slice(0, 10),
    type: c.type, party: c.label || 'Kalkylator', desc: c.label || 'Uträkning',
    exkl: c.exkl, vat: c.vat, total: c.total, rate: c.rate,
    fileData: '', note: 'Från momskalkylatorn', createdAt: new Date().toISOString(),
  });
  c.bookedId = rid;
  // Show the period the receipt landed in, so it's never "invisible".
  const k = currentPeriodKey(state.settings.period, new Date((c.date || new Date(c.ts).toISOString().slice(0, 10)) + 'T00:00:00'));
  state.activePeriod = (k === currentPeriodKey(state.settings.period)) ? null : k;
  save(); renderAll();
  toast(`Tillagt som kvitto i ${periodLabel(state.settings.period, k)} ✓`);
}

function renderDeclaration() {
  const t = declTotals();
  const rows = [
    ['05', 'Momspliktig försäljning (exkl. moms)', t.sales],
    ['10', 'Utgående moms 25 %', t.u25],
    ['11', 'Utgående moms 12 %', t.u12],
    ['12', 'Utgående moms 6 %', t.u6],
  ];
  if (t.euServices >= 0.5) {
    rows.push(['21', 'Inköp av tjänster från annat EU-land', t.euServices]);
    rows.push(['30', 'Utgående moms 25 % på inköp (ruta 20–21)', t.reverseVat]);
  }
  rows.push(['48', 'Ingående moms att dra av', t.ing]);
  const tbody = document.getElementById('declRows');
  tbody.innerHTML = rows.map(([n, label, val]) =>
    `<tr><td class="decl-ruta">${n}</td><td>${label}</td><td class="num">${kr(val)}</td></tr>`
  ).join('') +
    `<tr class="total"><td class="decl-ruta">49</td><td>Moms att ${t.toPay >= 0 ? 'betala' : 'få tillbaka'}</td><td class="num">${kr(Math.abs(t.toPay))}</td></tr>`;

  const adv = [
    ['20', 'Inköp av varor från annat EU-land'],
    ['35', 'Försäljning av varor till annat EU-land'],
    ['39', 'Försäljning av tjänster till näringsidkare i EU'],
  ];
  document.getElementById('declAdvRows').innerHTML = adv.map(([n, label]) =>
    `<tr><td class="decl-ruta">${n}</td><td>${label}</td><td class="num">0 kr</td></tr>`
  ).join('');
}

function renderSettingsForm() {
  document.getElementById('setName').value = state.settings.name;
  document.getElementById('setOrg').value = state.settings.org;
  document.getElementById('setPeriod').value = state.settings.period;
  document.getElementById('setStart').value = state.settings.start || '';
  document.getElementById('setDeadline').value = state.settings.deadlineOverride || '';
}

/* =========================================================
   Actions
   ========================================================= */
function deleteReceipt(id) {
  if (!confirm('Ta bort det här kvittot?')) return;
  state.receipts = state.receipts.filter(r => r.id !== id);
  save(); renderAll(); toast('Kvitto borttaget');
}

function nextVerNr() {
  const max = state.receipts.reduce((m, r) => Math.max(m, r.verNr || 0), 0);
  return max + 1;
}

/* ---------- Image compression to keep localStorage small ---------- */
function compressImage(file) {
  return new Promise((resolve) => {
    if (!file) return resolve('');
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1100;
        let { width, height } = img;
        if (width > max || height > max) {
          const s = max / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve('');
      img.src = reader.result;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

/* =========================================================
   Wire up
   ========================================================= */
function navTo(view) {
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + view);
  document.querySelectorAll('[data-view]').forEach(n =>
    n.classList.toggle('active', n.dataset.view === view));
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  window.scrollTo(0, 0);
}

function setupNav() {
  document.querySelectorAll('[data-view]').forEach(n =>
    n.addEventListener('click', (e) => { e.preventDefault(); navTo(n.dataset.view); }));
  document.querySelectorAll('[data-goto]').forEach(b =>
    b.addEventListener('click', () => navTo(b.dataset.goto)));
  const start = (location.hash || '#oversikt').slice(1);
  navTo(['oversikt','kvitton','kalkylator','deklaration','anteckningar','installningar'].includes(start) ? start : 'oversikt');
}

function setupReceiptForm() {
  const form = document.getElementById('receiptForm');
  const dateEl = document.getElementById('rfDate');
  dateEl.value = new Date().toISOString().slice(0, 10);

  const readInputs = () => ({
    amount: parseFloat(String(form.amount.value).replace(',', '.')) || 0,
    rate: Number(form.rate.value),
    inclusive: form.inclusive.value,
  });
  const updatePreview = () => {
    const { amount, rate, inclusive } = readInputs();
    const c = computeVat(amount, rate, inclusive);
    document.getElementById('calcVat').textContent = kr(c.vat);
    document.getElementById('calcExcl').textContent = kr(c.exkl);
    document.getElementById('calcTotal').textContent = kr(c.total);
  };
  form.addEventListener('input', updatePreview);
  updatePreview();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { amount, rate, inclusive } = readInputs();
    if (amount <= 0) { toast('Fyll i ett belopp'); return; }
    const c = computeVat(amount, rate, inclusive);
    const fileData = await compressImage(form.file.files[0]);
    state.receipts.push({
      id: 'r' + Date.now() + Math.random().toString(36).slice(2, 6),
      verNr: nextVerNr(),
      date: form.date.value,
      type: form.type.value,
      party: form.party.value.trim(),
      desc: form.desc.value.trim(),
      exkl: c.exkl, vat: c.vat, total: c.total, rate,
      fileData,
      note: form.note.value.trim(),
      createdAt: new Date().toISOString(),
    });
    save();
    form.reset();
    dateEl.value = new Date().toISOString().slice(0, 10);
    updatePreview();
    renderAll();
    toast('Kvitto sparat ✓');
  });
  form.addEventListener('reset', () => setTimeout(updatePreview, 0));
}

function setupCalculator() {
  const amount = document.getElementById('cAmount');
  const incl = document.getElementById('cIncl');
  const rate = document.getElementById('cRate');
  const what = document.getElementById('cWhat');
  const dateEl = document.getElementById('cDate');
  const view = document.getElementById('view-kalkylator');
  dateEl.value = new Date().toISOString().slice(0, 10);

  const read = () => ({
    amount: parseFloat(String(amount.value).replace(',', '.')) || 0,
    inclusive: incl.value,
    rate: Number(rate.value),
    type: view.querySelector('input[name="ctype"]:checked').value,
    label: what.value.trim() || 'Uträkning',
    date: dateEl.value || new Date().toISOString().slice(0, 10),
  });
  const update = () => {
    const v = read();
    const c = computeVat(v.amount, v.rate, v.inclusive);
    document.getElementById('cExcl').textContent = kr(c.exkl);
    document.getElementById('cVat').textContent = kr(c.vat);
    document.getElementById('cTotal').textContent = kr(c.total);
    document.getElementById('cRateLbl').textContent = `(${v.rate} %)`;
    const ctx = document.getElementById('cContext');
    const isInkop = v.type === 'inkop';
    document.getElementById('cContextLabel').textContent = isInkop ? 'Moms att få tillbaka' : 'Moms att betala';
    document.getElementById('cContextVal').textContent = kr(c.vat);
    ctx.classList.toggle('is-refund', isInkop);
    ctx.classList.toggle('is-pay', !isInkop);
  };
  view.addEventListener('input', update);
  view.addEventListener('change', update);
  update();

  document.getElementById('calcSave').addEventListener('click', () => {
    const v = read();
    if (v.amount <= 0) { toast('Fyll i ett belopp'); amount.focus(); return; }
    const c = computeVat(v.amount, v.rate, v.inclusive);
    state.calculations.push({
      id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
      ts: Date.now(), date: v.date,
      label: v.label, type: v.type, amount: v.amount, inclusive: v.inclusive, rate: v.rate,
      exkl: c.exkl, vat: c.vat, total: c.total, bookedId: null,
    });
    save();
    amount.value = ''; what.value = '';
    dateEl.value = new Date().toISOString().slice(0, 10);
    update(); renderCalcList();
    toast('Uträkning sparad ✓');
  });
}

function setupSettings() {
  document.getElementById('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.settings.name = document.getElementById('setName').value.trim();
    state.settings.org = document.getElementById('setOrg').value.trim();
    state.settings.start = document.getElementById('setStart').value;
    state.settings.deadlineOverride = document.getElementById('setDeadline').value;
    const newPeriod = document.getElementById('setPeriod').value;
    if (newPeriod !== state.settings.period) { state.settings.period = newPeriod; state.activePeriod = null; }
    save(); renderAll(); toast('Sparat ✓'); navTo('oversikt');
  });

  document.getElementById('backupBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `moms-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  });
  // Share the full data file to another device (sms/mejl/AirDrop), with
  // download as fallback where Web Share isn't available (e.g. desktop).
  document.getElementById('shareDataBtn').addEventListener('click', async () => {
    const json = JSON.stringify(state, null, 2);
    const fname = `moms-data-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const file = new File([json], fname, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Moms — min data', text: 'Öppna Moms-appen på den andra enheten → Inställningar → Läs in data från fil.' });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = fname;
    a.click();
    toast('Filen laddades ner — skicka den till dig själv (sms/mejl) och läs in den på andra enheten.', 4500);
  });

  document.getElementById('restoreInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(reader.result);
        if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.receipts)) {
          toast('Det där ser inte ut som en Moms-datafil.'); return;
        }
        const hasData = state.receipts.length || state.calculations.length || state.notes;
        if (hasData && !confirm('Den här enheten har redan data. Ersätta den med filens innehåll?')) return;
        state = Object.assign(defaultState(), incoming);
        // Same migration as load(): flag old Stripe fees as reverse charge.
        state.receipts.forEach(r => {
          if (r.desc === 'Stripe-avgift' && r.type === 'inkop' && !r.reverse) r.reverse = true;
        });
        save(); renderAll(); toast('Data inläst ✓'); navTo('oversikt');
      } catch { toast('Kunde inte läsa filen'); }
      e.target.value = '';
    };
    reader.readAsText(file);
  });
  document.getElementById('wipeBtn').addEventListener('click', () => {
    if (!confirm('Radera ALLT? Detta går inte att ångra.')) return;
    state = defaultState(); save(); renderAll(); toast('Allt raderat'); navTo('oversikt');
  });
}

function setupNotes() {
  const ta = document.getElementById('notes');
  const saved = document.getElementById('notesSaved');
  let timer;
  ta.addEventListener('input', () => {
    state.notes = ta.value;
    clearTimeout(timer);
    timer = setTimeout(() => { save(); saved.classList.add('show'); setTimeout(() => saved.classList.remove('show'), 1200); }, 400);
  });
}

function setupPeriodSheet() {
  const sheet = document.getElementById('periodSheet');
  const open = () => {
    const opts = document.getElementById('periodOptions');
    const cur = activeKey();
    opts.innerHTML = '';
    periodChoices().reverse().forEach(key => {
      const btn = document.createElement('button');
      btn.className = 'period-opt' + (key === cur ? ' active' : '');
      const dl = deadlineFor(state.settings.period, key);
      btn.innerHTML = `<span>${periodLabel(state.settings.period, key)}</span><span class="muted small">deadline ${dl.getDate()}/${dl.getMonth()+1}</span>`;
      btn.addEventListener('click', () => {
        state.activePeriod = (key === currentPeriodKey(state.settings.period)) ? null : key;
        save(); renderAll(); closeSheet();
      });
      opts.appendChild(btn);
    });
    sheet.hidden = false;
  };
  const closeSheet = () => { sheet.hidden = true; };
  document.getElementById('periodPill').addEventListener('click', open);
  sheet.querySelectorAll('[data-close-sheet]').forEach(el => el.addEventListener('click', closeSheet));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
}

/* ---------- Cloud sync via a private Hugging Face dataset ----------
   The user's HF token acts as the "login". It is stored separately from
   the app data so backups and transfer files never contain it. */
const SYNC_KEY = 'moms.sync.v1';
let syncCfg = (() => { try { return JSON.parse(localStorage.getItem(SYNC_KEY)); } catch { return null; } })();
let syncPushTimer = null;
let syncBusy = false;

const hfBase = () => (syncCfg && syncCfg.base) || 'https://huggingface.co';

function saveSyncCfg() {
  if (syncCfg) localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
  else localStorage.removeItem(SYNC_KEY);
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function syncPush() {
  if (!syncCfg || syncBusy) return;
  syncBusy = true;
  try {
    const json = JSON.stringify(state);
    const nd = JSON.stringify({ key: 'header', value: { summary: 'moms sync' } }) + '\n' +
      JSON.stringify({ key: 'file', value: { path: 'data.json', content: b64encodeUtf8(json), encoding: 'base64' } });
    const r = await fetch(`${hfBase()}/api/datasets/${syncCfg.repo}/commit/main`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + syncCfg.token, 'Content-Type': 'application/x-ndjson' },
      body: nd,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    syncCfg.lastSync = Date.now(); saveSyncCfg();
    renderSyncPanel();
  } catch (e) {
    renderSyncPanel('Kunde inte synka just nu — försöker igen vid nästa ändring.');
  } finally { syncBusy = false; }
}

function scheduleSyncPush() {
  if (!syncCfg) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(syncPush, 2500);
}

async function syncPull() {
  if (!syncCfg) return null;
  const r = await fetch(`${hfBase()}/datasets/${syncCfg.repo}/resolve/main/data.json?ts=` + Date.now(), {
    headers: { Authorization: 'Bearer ' + syncCfg.token },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Pull from the cloud and apply if the cloud copy is newer than ours.
async function syncPullApply() {
  if (!syncCfg || syncBusy) return;
  try {
    const remote = await syncPull();
    if (remote && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
      state = Object.assign(defaultState(), remote);
      state.receipts.forEach(r => {
        if (r.desc === 'Stripe-avgift' && r.type === 'inkop' && !r.reverse) r.reverse = true;
      });
      save({ skipSync: true });
      renderAll();
      toast('Hämtade senaste datan från molnet ✓');
    }
    syncCfg.lastSync = Date.now(); saveSyncCfg();
    renderSyncPanel();
  } catch (e) {
    renderSyncPanel('Kunde inte nå molnet — visar det som finns på enheten.');
  }
}

async function enableSync(token) {
  const who = await fetch(hfBase() + '/api/whoami-v2', { headers: { Authorization: 'Bearer ' + token } });
  if (!who.ok) throw new Error('Nyckeln verkar ogiltig — kontrollera att du kopierade hela (hf_…).');
  const user = (await who.json()).name;
  const repo = `${user}/moms-data`;
  const cr = await fetch(hfBase() + '/api/repos/create', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'moms-data', type: 'dataset', private: true }),
  });
  if (!cr.ok && cr.status !== 409) {
    const t = await cr.text().catch(() => '');
    if (!/exist/i.test(t)) throw new Error('Kunde inte skapa molnarkivet. Har nyckeln Write-behörighet?');
  }
  syncCfg = Object.assign({}, syncCfg, { token, repo });
  delete syncCfg.lastSync;
  saveSyncCfg();

  // First connect: decide direction.
  const remote = await syncPull().catch(() => null);
  const localHasData = state.receipts.length || state.calculations.length || state.notes;
  if (remote && (remote.receipts || []).length && !localHasData) {
    state = Object.assign(defaultState(), remote);
    save({ skipSync: true }); renderAll();
    toast('Hämtade din data från molnet ✓');
  } else if (remote && (remote.receipts || []).length && localHasData) {
    const useCloud = confirm('Det finns redan data i molnet OCH på den här enheten.\n\nOK = använd molnets data (ersätter enhetens)\nAvbryt = skriv över molnet med den här enhetens data');
    if (useCloud) {
      state = Object.assign(defaultState(), remote);
      save({ skipSync: true }); renderAll();
    } else {
      await syncPush();
    }
  } else {
    await syncPush();
  }
  syncCfg.lastSync = Date.now(); saveSyncCfg();
}

function renderSyncPanel(errMsg) {
  const off = document.getElementById('cloudOff');
  const on = document.getElementById('cloudOn');
  if (!off || !on) return;
  const active = !!syncCfg && !!syncCfg.token;
  off.hidden = active;
  on.hidden = !active;
  if (active) {
    const st = document.getElementById('syncStatus');
    const info = document.getElementById('syncInfo');
    if (errMsg) {
      st.textContent = 'Moln-synk är på — men senaste försöket misslyckades';
      info.textContent = errMsg;
    } else {
      st.textContent = 'Moln-synk är på ✓';
      const when = syncCfg.lastSync ? new Date(syncCfg.lastSync) : null;
      info.textContent = `Sparas automatiskt till ett privat arkiv (${syncCfg.repo})` +
        (when ? ` · senast synkad ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}` : '');
    }
  }
}

function setupCloudSync() {
  renderSyncPanel();
  document.getElementById('syncEnableBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const token = document.getElementById('hfToken').value.trim();
    if (!token) { toast('Klistra in din nyckel först'); return; }
    btn.disabled = true; btn.textContent = 'Kopplar…';
    try {
      await enableSync(token);
      document.getElementById('hfToken').value = '';
      renderSyncPanel();
      toast('Moln-synk är på — allt sparas nu automatiskt 🎉', 4000);
    } catch (err) {
      toast(err.message || 'Något gick fel. Försök igen.', 4500);
    } finally { btn.disabled = false; btn.textContent = 'Aktivera moln-synk'; }
  });
  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    toast('Synkar…');
    await syncPush();
    await syncPullApply();
    toast('Synkat ✓');
  });
  document.getElementById('syncOffBtn').addEventListener('click', () => {
    if (!confirm('Koppla från moln-synk på den här enheten? Datan i molnet och på enheten finns kvar.')) return;
    syncCfg = null; saveSyncCfg(); renderSyncPanel(); toast('Moln-synk frånkopplad');
  });
  // Catch changes made on the other device when returning to the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncPullApply();
  });
}

/* ---------- Reminders: calendar (.ics) + notifications ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }

function downloadIcs() {
  if (!currentDeadline) return;
  const d = currentDeadline;
  const dateStr = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const next = new Date(d); next.setDate(next.getDate() + 1);
  const endStr = `${next.getFullYear()}${pad2(next.getMonth() + 1)}${pad2(next.getDate())}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const period = periodLabel(state.settings.period, activeKey());
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Moms//SV//', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:moms-${activeKey()}-${dateStr}@moms.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateStr}`,
    `DTEND;VALUE=DATE:${endStr}`,
    `SUMMARY:Deklarera & betala moms (${period})`,
    'DESCRIPTION:Lämna momsdeklaration och betala hos Skatteverket. Kontrollera exakt datum.',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Moms-deadline om 7 dagar', 'TRIGGER:-P7D', 'END:VALARM',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Moms-deadline imorgon', 'TRIGGER:-P1D', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `moms-deadline-${activeKey()}.ics`;
  a.click();
  toast('Kalenderpåminnelse skapad 📅');
}

function maybeNotify(force) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!state.settings.notify || currentDeadline == null) return;
  if (currentDeadlineDays < 0 || currentDeadlineDays > 14) return;
  const key = `${activeKey()}-${currentDeadline.toDateString()}`;
  if (!force && state._notifiedKey === key) return;
  state._notifiedKey = key; save();
  const dStr = `${currentDeadline.getDate()} ${MONTHS[currentDeadline.getMonth()]}`;
  new Notification('Moms — deadline närmar sig', {
    body: `${currentDeadlineDays} dagar kvar till ${dStr}. Dags att deklarera.`,
    icon: 'icon-192.png', badge: 'icon-192.png',
  });
}

/* ---------- Stripe CSV import ---------- */
// Minimal CSV parser handling quotes ("") and , or ; delimiters.
function parseCsv(text) {
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const firstLine = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const delim = (firstLine.split(';').length > firstLine.split(',').length) ? ';' : ',';
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.length && r.some(c => c.trim() !== ''));
}

function numSv(s) {
  if (s == null) return 0;
  s = String(s).replace(/[^\d.,-]/g, '');
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) s = s.replace(/,/g, '');       // 1,234.56
  else if (s.indexOf(',') > -1) s = s.replace(',', '.');                          // 12,34
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function toIsoDate(s) {
  if (!s) return new Date().toISOString().slice(0, 10);
  s = String(s).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

// Pick the transaction-date column, preferring settlement/created dates over due dates.
function findDate(headers) {
  for (const re of [/available.?on/, /created.*utc/, /^created/, /date.*utc/, /date/]) {
    const i = headers.findIndex(h => re.test(h) && !/due/.test(h));
    if (i > -1) return i;
  }
  return -1;
}

// Pick a "who" column, avoiding amount/currency/id columns that contain "customer".
function findCust(headers) {
  const bad = /(amount|currency|facing|fee|net|gross|number|^id$|_id$|country|zip|postal)/;
  const good = [/customer.?email/, /customer.?name/, /card.?name/, /^customer$/, /^description$/, /statement.?descriptor/];
  for (const re of good) {
    const i = headers.findIndex(h => re.test(h) && !bad.test(h));
    if (i > -1) return i;
  }
  return -1;
}

// Inspect a parsed Stripe CSV and return import rows + meta.
function analyzeStripe(rows) {
  if (rows.length < 2) return { error: 'Filen verkar tom eller saknar rader.' };
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const find = (re) => headers.findIndex(h => re.test(h));
  const col = {
    id: find(/balance.?transaction|^id$|^charge.?id|source.?id/),
    cat: find(/reporting.?category|^type$/),
    date: findDate(headers),
    gross: find(/^gross$/),
    net: find(/^net$/),
    fee: find(/^fee$|^fees$/),
    cur: find(/^currency$/),
    convAmt: headers.findIndex(h => /converted.*amount/.test(h) && !/refund/.test(h)),
    convCur: find(/converted.*currency/),
    amount: headers.findIndex(h => /^amount$/.test(h) && !/refund/.test(h)),
    total: find(/^total$/),
    paid: find(/^amount paid$/),
    sub: find(/^subtotal$/),
    due: find(/^amount due$/),
    cust: findCust(headers),
  };
  // An Invoices export has amount-paid/number/subscription but no gross/fee/converted.
  const invoiceLike = col.gross < 0 && col.convAmt < 0 && col.fee < 0 &&
    find(/amount paid|amount due|^number$|subscription/) > -1;

  const items = []; let curWarn = '';
  const amountFromRow = (c) => {
    for (const k of ['gross', 'convAmt', 'amount', 'total', 'paid', 'sub', 'due']) {
      if (col[k] > -1) {
        const curCol = k === 'convAmt' ? col.convCur : col.cur;
        return { gross: numSv(c[col[k]]), cur: curCol > -1 ? (c[curCol] || '') : '' };
      }
    }
    return null;
  };
  for (let r = 1; r < rows.length; r++) {
    const c = rows[r];
    const cat = col.cat > -1 ? (c[col.cat] || '').toLowerCase() : '';
    if (/payout/.test(cat)) continue;                      // skip the payout line itself
    const a = amountFromRow(c);
    if (!a) continue;
    if (a.cur && a.cur.toUpperCase() !== 'SEK') curWarn = a.cur.toUpperCase();
    const id = col.id > -1 ? (c[col.id] || '') : '';
    const date = toIsoDate(col.date > -1 ? c[col.date] : '');
    if (a.gross > 0) {                                      // a sale/charge
      const fee = col.fee > -1 ? Math.abs(numSv(c[col.fee])) : 0;
      items.push({
        kind: 'sale', id, date, gross: a.gross, fee,
        party: (col.cust > -1 ? (c[col.cust] || '') : '').trim() || 'Stripe-kund',
      });
    } else if (/fee/.test(cat)) {                          // a standalone Stripe fee row
      const amt = Math.abs(a.gross) || (col.fee > -1 ? Math.abs(numSv(c[col.fee])) : 0);
      if (amt > 0) items.push({ kind: 'fee', id, date, fee: amt });
    }
    // refunds / adjustments / zero rows are ignored
  }
  // Keep a payout together: align standalone fee rows to the sale's date so a
  // fee and its sale never split across two quarters.
  const saleDates = items.filter(i => i.kind === 'sale').map(i => i.date).sort();
  if (saleDates.length) {
    const anchor = saleDates[saleDates.length - 1];
    for (const it of items) if (it.kind === 'fee') it.date = anchor;
  }
  return { items, curWarn, invoiceLike, headers };
}

let pendingImport = null;

function setupStripeImport() {
  const fileEl = document.getElementById('impFile');
  const preview = document.getElementById('impPreview');
  const confirmBtn = document.getElementById('impConfirm');

  document.getElementById('impAnalyze').addEventListener('click', () => {
    const file = fileEl.files[0];
    if (!file) { toast('Välj en CSV-fil först'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let res;
      try { res = analyzeStripe(parseCsv(reader.result)); }
      catch { res = { error: 'Kunde inte läsa filen.' }; }
      if (res.error || !res.items) {
        preview.hidden = false; confirmBtn.hidden = true;
        preview.innerHTML = `<div class="imp-warn">${res.error || 'Hittade inga rader att importera.'}</div>`;
        return;
      }
      const invoiceMsg = `Det här ser ut som en <strong>Faktura-export</strong> — den är i utländsk valuta och saknar Stripe-avgifter. För korrekt moms i SEK: i Stripe, gå till <strong>Balance → Payouts</strong> och exportera den rapporten istället (den har gross/fee/net i SEK).`;
      if (!res.items.length) {
        preview.hidden = false; confirmBtn.hidden = true;
        preview.innerHTML = `<div class="imp-warn">${res.invoiceLike ? invoiceMsg : 'Hittade inga försäljningsrader. Kontrollera att du exporterat rätt rapport (med kolumnerna gross/fee, eller Converted Amount).'}</div>`;
        return;
      }
      const incFees = document.getElementById('impFees').checked;
      const isDupe = (i) => i.id && state.importedIds[i.id];
      const newItems = res.items.filter(i => !isDupe(i));     // what will actually be created
      const newSales = newItems.filter(i => i.kind === 'sale');
      const dupes = res.items.length - newItems.length;
      const totGross = newSales.reduce((s, i) => s + (i.gross || 0), 0);
      const totFee = newItems.reduce((s, i) => s + (i.fee || 0), 0);
      const blockImport = !!res.curWarn;                      // don't import non-SEK amounts as SEK
      const nothingNew = newItems.length === 0;
      pendingImport = (blockImport || nothingNew) ? null : res.items;
      const periodsOf = (arr) => [...new Set(arr.map(i =>
        periodLabel(state.settings.period, currentPeriodKey(state.settings.period, new Date(i.date + 'T00:00:00')))))];
      const rowsHtml = res.items.slice(0, 6).map(i =>
        i.kind === 'fee'
          ? `<tr><td>${fmtDate(i.date)}</td><td>Stripe-avgift</td><td class="num">—</td><td class="num">${kr(i.fee)}</td></tr>`
          : `<tr><td>${fmtDate(i.date)}</td><td>${esc(i.party)}</td><td class="num">${kr(i.gross)}</td><td class="num">${kr(i.fee)}</td></tr>`
      ).join('');
      preview.hidden = false; confirmBtn.hidden = blockImport || nothingNew;
      let footer;
      if (res.curWarn) {
        footer = `<div class="imp-warn">Beloppen är i ${res.curWarn}, inte SEK${res.invoiceLike ? ' (faktura-export utan avgifter)' : ''}. Importen är pausad så att inga felaktiga belopp bokförs.<br>Exportera istället <strong>Balance → Payouts</strong> i SEK, så funkar det direkt.</div>`;
      } else if (nothingNew) {
        const where = periodsOf(res.items.filter(i => i.kind === 'sale')).join(', ') || periodsOf(res.items).join(', ');
        footer = `<div class="imp-ok">Allt i den här filen är redan importerat ✓</div><div class="imp-stat" style="margin-top:6px"><span>Kvittona ligger under</span><strong>${where}</strong></div><p class="muted small">Växla period uppe till vänster för att se dem.</p>`;
      } else {
        footer = `<div class="imp-ok">Beloppen tolkas som SEK ✓</div>`;
      }
      preview.innerHTML = `
        <h4>Förhandsgranskning</h4>
        <div class="imp-stat"><span>Försäljningar ${blockImport ? 'i filen' : 'att skapa'}</span><strong>${(blockImport ? res.items.filter(i=>i.kind==='sale') : newSales).length} st</strong></div>
        <div class="imp-stat"><span>Summa försäljning (brutto)</span><strong>${kr(totGross)}</strong></div>
        <div class="imp-stat"><span>Stripe-avgifter ${incFees ? '(skapas som inköp)' : '(hoppas över)'}</span><strong>${kr(totFee)}</strong></div>
        ${dupes ? `<div class="imp-stat"><span>Redan importerade (hoppas över)</span><strong>${dupes} st</strong></div>` : ''}
        <table><thead><tr><th>Datum</th><th>Motpart</th><th class="num">Brutto</th><th class="num">Avgift</th></tr></thead><tbody>${rowsHtml}</tbody></table>
        ${res.items.length > 6 ? `<p class="muted small">…och ${res.items.length - 6} till.</p>` : ''}
        ${footer}`;
    };
    reader.readAsText(file);
  });

  confirmBtn.addEventListener('click', () => {
    if (!pendingImport) return;
    const rate = Number(document.getElementById('impRate').value);
    const incFees = document.getElementById('impFees').checked;
    let ver = nextVerNr();
    const newId = () => 'r' + Date.now() + Math.random().toString(36).slice(2, 6);
    const feeReceipt = (date, amt) => ({
      id: newId(), verNr: ver++, date, type: 'inkop', party: 'Stripe', desc: 'Stripe-avgift',
      exkl: amt, vat: 0, total: amt, rate: 0, fileData: '', reverse: true,
      note: 'Importerad från Stripe · EU-tjänst, omvänd skattskyldighet 25 %', createdAt: new Date().toISOString(),
    });
    let made = 0, skipped = 0, lastSaleDate = null;
    for (const it of pendingImport) {
      if (it.id && state.importedIds[it.id]) { skipped++; continue; }
      if (it.kind === 'fee') {
        if (incFees && it.fee > 0) state.receipts.push(feeReceipt(it.date, it.fee));
      } else {
        const c = computeVat(it.gross, rate, 'inkl');
        state.receipts.push({
          id: newId(), verNr: ver++, date: it.date, type: 'forsaljning', party: it.party,
          desc: 'Stripe-försäljning', exkl: c.exkl, vat: c.vat, total: c.total, rate, fileData: '',
          note: 'Importerad från Stripe', createdAt: new Date().toISOString(),
        });
        if (incFees && it.fee > 0) state.receipts.push(feeReceipt(it.date, it.fee));
        lastSaleDate = it.date;
      }
      if (it.id) state.importedIds[it.id] = true;
      made++;
    }
    // Jump to the period the imported sales belong to, so they're visible.
    let landedNote = '';
    if (lastSaleDate) {
      const k = currentPeriodKey(state.settings.period, new Date(lastSaleDate + 'T00:00:00'));
      state.activePeriod = (k === currentPeriodKey(state.settings.period)) ? null : k;
      landedNote = ` till ${periodLabel(state.settings.period, k)}`;
    }
    save(); renderAll();
    document.getElementById('impPreview').hidden = true;
    confirmBtn.hidden = true;
    document.getElementById('impFile').value = '';
    pendingImport = null;
    toast(`Importerade ${made} poster${landedNote}${skipped ? `, hoppade över ${skipped}` : ''} ✓`, 3500);
  });
}

function setupReminders() {
  document.getElementById('icsBtn').addEventListener('click', downloadIcs);
  document.getElementById('notifyBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('Din webbläsare stödjer inte notiser'); return; }
    if (state.settings.notify) {
      state.settings.notify = false; save(); renderOverview(); toast('Påminnelser av');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      state.settings.notify = true; save(); renderOverview();
      toast('Påminnelser på 🔔'); maybeNotify(true);
    } else {
      toast('Notiser blockerade i webbläsaren');
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

function setupHints() {
  document.querySelectorAll('.hint').forEach(h =>
    h.addEventListener('click', () => toast(h.dataset.hint, 3500)));
}

// Build a full-quarter report (summary + every receipt) for the accountant.
function buildQuarterReport() {
  const t = declTotals();
  const dl = state.settings.deadlineOverride
    ? new Date(state.settings.deadlineOverride + 'T00:00:00')
    : deadlineFor(state.settings.period, activeKey());
  const dlStr = `${dl.getDate()} ${MONTHS[dl.getMonth()]} ${dl.getFullYear()}`;
  const rs = receiptsInPeriod();
  const L = (...cells) => cells.map(csvCell).join(';');
  const lines = [
    L('Momsunderlag', state.settings.name || ''),
    L('Org.nr/personnr', state.settings.org || ''),
    L('Period', periodLabel(state.settings.period, activeKey())),
    L('Deadline (kontrollera hos Skatteverket)', dlStr),
    L('Redovisningsmetod', 'Bokslutsmetoden – moms redovisas vid betalning'),
    '',
    L('Momsdeklaration (rutor)', 'Belopp kr'),
    L('05  Momspliktig försäljning (exkl. moms)', Math.round(t.sales)),
    L('10  Utgående moms 25%', Math.round(t.u25)),
    L('11  Utgående moms 12%', Math.round(t.u12)),
    L('12  Utgående moms 6%', Math.round(t.u6)),
    ...(t.euServices >= 0.5 ? [
      L('21  Inköp av tjänster från annat EU-land', Math.round(t.euServices)),
      L('30  Utgående moms 25% på inköp (ruta 20-21)', Math.round(t.reverseVat)),
    ] : []),
    L('48  Ingående moms att dra av', Math.round(t.ing)),
    L(`49  Moms att ${t.toPay >= 0 ? 'betala' : 'få tillbaka'}`, Math.round(Math.abs(t.toPay))),
    '',
    L(`Verifikationer (${rs.length} st)`),
    L('Vernr', 'Datum', 'Typ', 'Motpart', 'Vad avser', 'Exkl moms', 'Momssats', 'Moms', 'Totalt', 'Anteckning'),
    ...rs.map(r => L(
      r.verNr, r.date,
      r.type === 'forsaljning' ? 'Försäljning' : (r.reverse ? 'Inköp (EU omvänd moms)' : 'Inköp'),
      r.party, r.desc, r.exkl.toFixed(2),
      r.reverse ? 'omvänd 25%' : r.rate + '%',
      (r.reverse ? r.exkl * 0.25 : r.vat).toFixed(2), r.total.toFixed(2), r.note || ''
    )),
  ];
  return '﻿' + lines.join('\r\n');
}

function quarterFilename() {
  const safe = (state.settings.name || 'moms').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'moms';
  return `momsunderlag-${safe}-${activeKey()}.csv`;
}

function setupExport() {
  const download = () => {
    const blob = new Blob([buildQuarterReport()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = quarterFilename();
    a.click();
    toast('Filen laddades ner ✓');
  };

  const share = async () => {
    const csv = buildQuarterReport();
    const fname = quarterFilename();
    const period = periodLabel(state.settings.period, activeKey());
    try {
      const file = new File([csv], fname, { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `Momsunderlag ${period}`,
          text: `Momsunderlag för ${period}${state.settings.name ? ' – ' + state.settings.name : ''}.`,
        });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled the share sheet
    }
    download();
    toast('Delning stöds inte här — filen laddades ner. Bifoga den i ett sms eller mejl.', 4000);
  };

  document.querySelectorAll('.js-share').forEach(b => b.addEventListener('click', share));
  document.getElementById('downloadBtn').addEventListener('click', download);
}

/* ---------- Small utils ---------- */
function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function csvCell(s) { s = String(s); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function fmtDate(iso) { const d = new Date(iso + 'T00:00:00'); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`; }
function fmtDateTime(ts) { const d = new Date(ts); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
let toastTimer;
function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.hidden = true, 300); }, ms);
}

/* ---------- Boot ---------- */
function boot() {
  setupNav();
  setupReceiptForm();
  setupCalculator();
  setupSettings();
  setupNotes();
  setupPeriodSheet();
  setupHints();
  setupExport();
  setupReminders();
  setupStripeImport();
  setupCloudSync();
  registerServiceWorker();
  renderAll();
  maybeNotify(false);
  syncPullApply();
  // First run: nudge to settings if nothing configured.
  if (!state.settings.name && !state.receipts.length) {
    toast('Välkommen! Ställ in din period under Inställningar ⚙', 3500);
  }
}
document.addEventListener('DOMContentLoaded', boot);
