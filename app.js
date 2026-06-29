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
    checks: {},            // { 'periodKey': [bool x5] }
    activePeriod: null,    // periodKey string, null = current
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    return Object.assign(defaultState(), JSON.parse(raw));
  } catch { return defaultState(); }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Kunde inte spara — lagringen kan vara full.'); }
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
  const t = { sales: 0, u25: 0, u12: 0, u6: 0, ing: 0 };
  for (const r of rs) {
    if (r.type === 'forsaljning') {
      t.sales += r.exkl;
      if (r.rate === 25) t.u25 += r.vat;
      else if (r.rate === 12) t.u12 += r.vat;
      else if (r.rate === 6) t.u6 += r.vat;
    } else {
      t.ing += r.vat;
    }
  }
  t.utg = t.u25 + t.u12 + t.u6;
  t.toPay = t.utg - t.ing; // ruta 49
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
        <div class="receipt-meta"><span>${fmtDate(r.date)}</span><span>${esc(r.desc)}</span><span>${r.rate}% moms</span></div>
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
        <div class="calc-row-meta">${esc(fmtDateTime(c.ts))} · ${c.rate}% moms · exkl ${kr(c.exkl)}</div>
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
    date: new Date(c.ts).toISOString().slice(0, 10),
    type: c.type, party: c.label || 'Kalkylator', desc: c.label || 'Uträkning',
    exkl: c.exkl, vat: c.vat, total: c.total, rate: c.rate,
    fileData: '', note: 'Från momskalkylatorn', createdAt: new Date().toISOString(),
  });
  c.bookedId = rid;
  save(); renderAll(); toast('Tillagt som kvitto ✓');
}

function renderDeclaration() {
  const t = declTotals();
  const rows = [
    ['05', 'Momspliktig försäljning (exkl. moms)', t.sales],
    ['10', 'Utgående moms 25 %', t.u25],
    ['11', 'Utgående moms 12 %', t.u12],
    ['12', 'Utgående moms 6 %', t.u6],
    ['48', 'Ingående moms att dra av', t.ing],
  ];
  const tbody = document.getElementById('declRows');
  tbody.innerHTML = rows.map(([n, label, val]) =>
    `<tr><td class="decl-ruta">${n}</td><td>${label}</td><td class="num">${kr(val)}</td></tr>`
  ).join('') +
    `<tr class="total"><td class="decl-ruta">49</td><td>Moms att ${t.toPay >= 0 ? 'betala' : 'få tillbaka'}</td><td class="num">${kr(Math.abs(t.toPay))}</td></tr>`;

  const adv = [
    ['20', 'Inköp av varor från annat EU-land'],
    ['21', 'Inköp av tjänster från annat EU-land'],
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
  const view = document.getElementById('view-kalkylator');

  const read = () => ({
    amount: parseFloat(String(amount.value).replace(',', '.')) || 0,
    inclusive: incl.value,
    rate: Number(rate.value),
    type: view.querySelector('input[name="ctype"]:checked').value,
    label: what.value.trim() || 'Uträkning',
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
      ts: Date.now(),
      label: v.label, type: v.type, amount: v.amount, inclusive: v.inclusive, rate: v.rate,
      exkl: c.exkl, vat: c.vat, total: c.total, bookedId: null,
    });
    save();
    amount.value = ''; what.value = '';
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
  document.getElementById('restoreInput').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state = Object.assign(defaultState(), JSON.parse(reader.result));
        save(); renderAll(); toast('Återställt ✓'); navTo('oversikt');
      } catch { toast('Kunde inte läsa filen'); }
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

function setupExport() {
  document.getElementById('exportBtn').addEventListener('click', () => {
    const rs = receiptsInPeriod();
    const header = 'Vernr;Datum;Typ;Motpart;Beskrivning;Exkl moms;Momssats;Moms;Totalt';
    const lines = rs.map(r => [
      r.verNr, r.date, r.type, r.party, r.desc,
      r.exkl.toFixed(2), r.rate + '%', r.vat.toFixed(2), r.total.toFixed(2)
    ].map(csvCell).join(';'));
    const csv = '﻿' + [header, ...lines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `moms-underlag-${activeKey()}.csv`;
    a.click();
    toast('Underlag exporterat ✓');
  });
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
  registerServiceWorker();
  renderAll();
  maybeNotify(false);
  // First run: nudge to settings if nothing configured.
  if (!state.settings.name && !state.receipts.length) {
    toast('Välkommen! Ställ in din period under Inställningar ⚙', 3500);
  }
}
document.addEventListener('DOMContentLoaded', boot);
