/* =========================================================
   Moms — bokföringsunderlag för enskild firma.
   All data lokalt i webbläsaren (+ valfri molnsynk). Sparade
   verifikationer är ORÖRLIGA: fel rättas med en ny post som
   hänvisar till den felaktiga (stornering), aldrig genom att
   ändra eller radera en tidigare post.
   ========================================================= */
'use strict';

const STORE_KEY = 'moms.data.v1';
const MONTHS = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];

const ACCOUNTS = {
  firmakonto: 'Firmakonto',
  kontant: 'Kontant',
  privat: 'Egen insättning (jag betalade privat)',
  annat: 'Annat',
};
const TYPE_LABEL = {
  forsaljning: 'Försäljning',
  inkop: 'Inköp',
  insattning: 'Egen insättning',
  uttag: 'Eget uttag',
};

/* ---------- State ---------- */
let state; // set by load() below
let currentDeadline = null;     // Date of the active period's deadline
let currentDeadlineDays = null; // days left until it
let formDraft = null;           // pending correction/booking prefill for the ledger form
let reportRangeMode = 'period'; // 'period' | 'year' | 'all' — transient, not persisted

function defaultState() {
  return {
    settings: { name: '', org: '', period: 'kvartal', start: '', deadlineOverride: '', notify: false },
    ledger: [],             // immutable verifikationer, see addLedgerEntry() for shape
    calculations: [],       // saved momskalkylator-uträkningar: {id, ts, date, label, type, gross, rate, net, vat, bookedId}
    notes: '',
    importedIds: {},        // Stripe balance-transaction ids already imported (dedupe)
    checks: {},             // { 'periodKey': [bool x5] }
    activePeriod: null,     // periodKey string, null = current
  };
}

// Every place data enters the app (first load, restore-from-file, cloud pull)
// goes through this so migration and gapless renumbering happen exactly once,
// consistently. Never mutates a ledger entry's meaning — only fills in fields
// that didn't exist in older data formats.
function migrateState(raw) {
  // Check the RAW input for a ledger before merging with defaultState() —
  // defaultState() always supplies ledger: [], so checking the merged
  // object would never detect legacy data that lacks a ledger key at all.
  const hasLedgerAlready = raw && Array.isArray(raw.ledger);
  const s = Object.assign(defaultState(), raw);

  if (!hasLedgerAlready) {
    // Coming from the pre-ledger "receipts" model. Renumber gaplessly by
    // date/verNr/createdAt order — required because receipts could
    // previously be deleted, which could leave gaps in verNr.
    const old = Array.isArray(s.receipts) ? s.receipts.slice() : [];
    old.sort((a, b) =>
      (a.date || '').localeCompare(b.date || '') ||
      (a.verNr || 0) - (b.verNr || 0) ||
      (a.createdAt || '').localeCompare(b.createdAt || ''));
    s.ledger = old.map((r, i) => ({
      id: r.id || ('v' + i),
      verNr: i + 1,
      txDate: r.date || new Date().toISOString().slice(0, 10),
      createdAt: r.createdAt || new Date().toISOString(),
      type: r.type === 'forsaljning' ? 'forsaljning' : 'inkop',
      desc: r.desc || '',
      party: r.party || '',
      gross: typeof r.total === 'number' ? r.total : (r.exkl || 0) + (r.vat || 0),
      rate: r.rate || 0,
      net: typeof r.exkl === 'number' ? r.exkl : (typeof r.total === 'number' ? r.total : 0),
      vat: r.vat || 0,
      account: 'okänt',
      ref: '',
      fileData: r.fileData || '',
      note: r.note || '',
      reverse: !!r.reverse,
      correctionOf: null,
      source: 'migrerad',
    }));
    delete s.receipts;
    s._migratedNotice = true;
  }

  // Legacy Stripe fees booked before reverse-charge support existed.
  s.ledger.forEach(e => {
    if (e.desc === 'Stripe-avgift' && e.type === 'inkop' && !e.reverse) e.reverse = true;
  });

  // Calculator entries: migrate old {amount, inclusive, exkl, total} shape to
  // the gross-first shape. `total` already held the gross figure either way.
  s.calculations = (s.calculations || []).map(c => ({
    id: c.id,
    ts: c.ts,
    date: c.date || new Date(c.ts || Date.now()).toISOString().slice(0, 10),
    label: c.label || 'Uträkning',
    type: c.type === 'inkop' ? 'inkop' : 'forsaljning',
    gross: typeof c.gross === 'number' ? c.gross : (c.total || 0),
    rate: c.rate,
    net: typeof c.net === 'number' ? c.net : (c.exkl || 0),
    vat: c.vat || 0,
    bookedId: c.bookedId || null,
  }));

  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    return migrateState(JSON.parse(raw));
  } catch { return defaultState(); }
}
state = load();

function save(opts) {
  state.updatedAt = Date.now();
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Kunde inte spara — lagringen kan vara full.'); }
  if (!(opts && opts.skipSync)) scheduleSyncPush();
}

/* ---------- Money & VAT helpers ---------- */
const kr = (n) => (Math.round(n) || 0).toLocaleString('sv-SE') + ' kr';

// Backwards VAT calculation from a gross (brutto) amount — the only direction
// entries are ever entered, per bokföringslagen-friendly gross-input design.
// Works for negative gross too (correction/stornering entries), since the
// identity gross = net + vat holds regardless of sign.
function vatFromGross(gross, rate) {
  const r = Number(rate) / 100;
  if (!rate) return { net: gross, vat: 0 };
  const net = gross / (1 + r);
  return { net, vat: gross - net };
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
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); // weekend -> next weekday
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
    for (let i = -5; i <= 1; i++) keys.push(currentPeriodKey('manad', new Date(now.getFullYear(), now.getMonth() + i, 1)));
  } else if (period === 'helar') {
    for (let i = -2; i <= 1; i++) keys.push(String(now.getFullYear() + i));
  } else {
    for (let i = -4; i <= 1; i++) keys.push(currentPeriodKey('kvartal', new Date(now.getFullYear(), now.getMonth() + i * 3, 1)));
  }
  let unique = [...new Set(keys)];
  if (state.settings.start) {
    const start = new Date(state.settings.start + 'T00:00:00');
    const filtered = unique.filter(k => periodRange(period, k).end >= start);
    if (filtered.length) unique = filtered;
  }
  return unique;
}

/* ---------- Ledger lookups ---------- */
function findLedgerById(id) { return state.ledger.find(e => e.id === id); }

function ledgerSorted() {
  return state.ledger.slice().sort((a, b) => a.verNr - b.verNr);
}

function ledgerInPeriod() {
  const { start, end } = periodRange(state.settings.period, activeKey());
  return ledgerSorted().filter(e => {
    const d = new Date(e.txDate + 'T00:00:00');
    return d >= start && d <= end;
  });
}

// entries for the Sammanställning/export range toggle: 'period' | 'year' | 'all'
function reportRangeDates(mode) {
  if (mode === 'all') return null;
  if (mode === 'year') {
    const y = periodRange(state.settings.period, activeKey()).start.getFullYear();
    return { start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
  }
  return periodRange(state.settings.period, activeKey());
}
function ledgerInRange(mode) {
  const range = reportRangeDates(mode);
  const all = ledgerSorted();
  if (!range) return all;
  return all.filter(e => { const d = new Date(e.txDate + 'T00:00:00'); return d >= range.start && d <= range.end; });
}

/* ---------- Totals: VAT boxes + result (revenue/cost) ---------- */
function summaryTotals(entries) {
  const t = {
    sales: 0, u25: 0, u12: 0, u6: 0, ing: 0, euServices: 0, reverseVat: 0,
    costNet: 0, insattningar: 0, uttag: 0,
  };
  for (const e of entries) {
    if (e.type === 'forsaljning') {
      t.sales += e.net;
      if (e.rate === 25) t.u25 += e.vat;
      else if (e.rate === 12) t.u12 += e.vat;
      else if (e.rate === 6) t.u6 += e.vat;
    } else if (e.type === 'inkop') {
      t.costNet += e.net;
      if (e.reverse) {
        const rv = e.net * 0.25;
        t.euServices += e.net;
        t.reverseVat += rv;
        t.ing += rv;
      } else {
        t.ing += e.vat;
      }
    } else if (e.type === 'insattning') {
      t.insattningar += e.gross;
    } else if (e.type === 'uttag') {
      t.uttag += e.gross;
    }
  }
  t.utg = t.u25 + t.u12 + t.u6 + t.reverseVat; // ruta 10+11+12+30
  t.toPay = t.utg - t.ing;                      // ruta 49
  t.result = t.sales - t.costNet;
  return t;
}

/* =========================================================
   Ledger mutation — append-only. There is no edit/delete path;
   corrections are new entries with correctionOf set.
   ========================================================= */
function nextVerNr() {
  return state.ledger.reduce((m, e) => Math.max(m, e.verNr || 0), 0) + 1;
}

function addLedgerEntry(input) {
  const isCapital = input.type === 'insattning' || input.type === 'uttag';
  const rate = isCapital ? 0 : Number(input.rate) || 0;
  const { net, vat } = vatFromGross(input.gross, rate);
  const entry = {
    id: 'v' + Date.now() + Math.random().toString(36).slice(2, 7),
    verNr: nextVerNr(),
    txDate: input.txDate,
    createdAt: new Date().toISOString(),
    type: input.type,
    desc: (input.desc || '').trim(),
    party: (input.party || '').trim(),
    gross: input.gross,
    rate, net, vat,
    account: input.account || 'annat',
    ref: (input.ref || '').trim(),
    fileData: input.fileData || '',
    note: (input.note || '').trim(),
    reverse: !isCapital && !!input.reverse,
    correctionOf: input.correctionOf || null,
    source: input.source || 'manual',
  };
  state.ledger.push(entry);
  return entry;
}

/* =========================================================
   Rendering
   ========================================================= */
function renderAll() {
  renderTopbar();
  renderOverview();
  renderLedgerList();
  renderCalcList();
  renderDeclaration();
  renderSummaryPanel();
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
  const t = summaryTotals(ledgerInPeriod());
  const override = state.settings.deadlineOverride;
  const dl = override ? new Date(override + 'T00:00:00') : deadlineFor(state.settings.period, activeKey());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((dl - today) / 86400000);

  document.getElementById('deadlineDate').textContent = `${dl.getDate()} ${MONTHS[dl.getMonth()]} ${dl.getFullYear()}`;
  const cd = document.getElementById('deadlineCountdown');
  let txt;
  if (days > 1) txt = `Om ${days} dagar`;
  else if (days === 1) txt = 'I morgon!';
  else if (days === 0) txt = 'Idag!';
  else txt = `${Math.abs(days)} dagar sedan (försenad?)`;
  cd.textContent = txt + (override ? ' · eget datum' : '');

  currentDeadline = dl;
  currentDeadlineDays = days;

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
  document.getElementById('sumCount').textContent = ledgerInPeriod().length;

  renderChecklist();
}

const CHECK_ITEMS = [
  'Samla alla underlag för perioden',
  'Kontrollera att momsen stämmer på varje verifikation',
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

function renderLedgerList() {
  const rs = ledgerInPeriod().slice().reverse();
  const list = document.getElementById('receiptList');
  document.getElementById('receiptCount').textContent = `${rs.length} st`;
  if (!rs.length) {
    list.innerHTML = `<div class="empty">Inga verifikationer i ${periodLabel(state.settings.period, activeKey()).toLowerCase()} än.<br>Lägg till din första ovan.</div>`;
    return;
  }
  // Look up corrections against the FULL ledger, not just this period's
  // slice — a correction can land in a different period than the error.
  const correctedBy = {};
  state.ledger.forEach(e => { if (e.correctionOf) correctedBy[e.correctionOf] = e; });

  list.innerHTML = '';
  for (const r of rs) {
    const row = document.createElement('div');
    row.className = 'receipt-row';
    const isSale = r.type === 'forsaljning';
    const isCapital = r.type === 'insattning' || r.type === 'uttag';
    const tagClass = isSale ? 'tag-in' : isCapital ? 'tag-capital' : 'tag-out';
    const thumb = r.fileData
      ? `<img class="receipt-thumb" src="${r.fileData}" alt="Kvitto" />`
      : `<span class="receipt-thumb"><svg class="ic"><use href="#i-receipt"/></svg></span>`;

    const metaBits = [fmtDate(r.txDate), esc(r.desc)];
    if (!isCapital) metaBits.push(r.reverse ? 'omvänd moms 25 %' : r.rate + '% moms');
    metaBits.push(`konto: ${esc(ACCOUNTS[r.account] || r.account)}`);

    const badges = [];
    if (r.correctionOf) {
      const orig = findLedgerById(r.correctionOf);
      badges.push(`<span class="corr-tag corr-of">Rättelse av #${orig ? orig.verNr : '?'}</span>`);
    }
    if (correctedBy[r.id]) {
      badges.push(`<span class="corr-tag corr-by">→ Rättad, se #${correctedBy[r.id].verNr}</span>`);
    }

    row.innerHTML = `
      ${thumb}
      <div class="receipt-main">
        <div class="receipt-title">#${r.verNr} · ${esc(r.party || (isCapital ? 'Eget kapital' : 'Okänd motpart'))} <span class="receipt-tag ${tagClass}">${TYPE_LABEL[r.type]}</span> ${badges.join(' ')}</div>
        <div class="receipt-meta"><span>${metaBits.join('</span><span>')}</span></div>
        ${r.ref ? `<div class="receipt-ref">Ref: ${esc(r.ref)}</div>` : ''}
      </div>
      <div class="receipt-amt">
        <div class="a">${kr(r.gross)}</div>
        ${isCapital ? '<div class="v">ingen moms</div>' : `<div class="v">moms ${kr(r.vat)}</div>`}
      </div>
      <button class="receipt-correct" aria-label="Rätta med ny post" data-correct="${r.id}" title="Rätta med ny post">
        <svg class="ic"><use href="#i-correct"/></svg>
      </button>`;
    row.querySelector('[data-correct]').addEventListener('click', () => correctEntry(r.id));
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
        <div class="calc-row-title">${esc(c.label)} <span class="receipt-tag ${isSale ? 'tag-in' : 'tag-out'}">${TYPE_LABEL[c.type]}</span></div>
        <div class="calc-row-meta">${esc(fmtDate(c.date))} · ${c.rate}% moms · netto ${kr(c.net)}</div>
      </div>
      <div class="calc-row-amt">
        <div class="a">${kr(c.gross)}</div>
        <div class="v">moms ${kr(c.vat)}</div>
      </div>
      <button class="calc-book" ${booked ? 'disabled' : ''} data-book="${c.id}">${booked ? 'Bokfört ✓' : 'Bokför som verifikation'}</button>`;
    if (!booked) row.querySelector('[data-book]').addEventListener('click', () => startBookCalc(c.id));
    list.appendChild(row);
  }
}

// Turn a saved calculation into a ledger entry. Since the calculator doesn't
// collect Motpart/Konto, we route through the ledger form (prefilled) so
// every verifikation still gets its required fields.
function startBookCalc(id) {
  const c = state.calculations.find(x => x.id === id);
  if (!c || c.bookedId) return;
  formDraft = {
    kind: 'calc-book',
    calcId: c.id,
    type: c.type, txDate: c.date, desc: c.label, gross: c.gross, rate: c.rate,
    bannerText: `📋 Bokför uträkning "${esc(c.label)}" — komplettera motpart och konto, kontrollera sedan och bokför.`,
  };
  navTo('kvitton');
  applyFormDraft();
}

function renderDeclaration() {
  const t = summaryTotals(ledgerInPeriod());
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

function reportRangeLabel(mode) {
  if (mode === 'all') return 'hela din bokföring';
  if (mode === 'year') return `helåret ${periodRange(state.settings.period, activeKey()).start.getFullYear()}`;
  return periodLabel(state.settings.period, activeKey()).toLowerCase();
}

function renderSummaryPanel() {
  const panel = document.getElementById('summaryPanel');
  if (!panel) return;
  document.querySelectorAll('.report-toggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.range === reportRangeMode));
  const t = summaryTotals(ledgerInRange(reportRangeMode));
  document.getElementById('sumRangeLabel').textContent = `Sammanställning för ${reportRangeLabel(reportRangeMode)}`;
  document.getElementById('sRevenue').textContent = kr(t.sales);
  document.getElementById('sCost').textContent = kr(t.costNet);
  document.getElementById('sResult').textContent = kr(t.result);
  document.getElementById('sUtg').textContent = kr(t.utg);
  document.getElementById('sIng').textContent = kr(t.ing);
  document.getElementById('sToPay').textContent = (t.toPay >= 0 ? 'Att betala: ' : 'Att få tillbaka: ') + kr(Math.abs(t.toPay));
  document.getElementById('sInsattning').textContent = kr(t.insattningar);
  document.getElementById('sUttag').textContent = kr(t.uttag);
}

function renderSettingsForm() {
  document.getElementById('setName').value = state.settings.name;
  document.getElementById('setOrg').value = state.settings.org;
  document.getElementById('setPeriod').value = state.settings.period;
  document.getElementById('setStart').value = state.settings.start || '';
  document.getElementById('setDeadline').value = state.settings.deadlineOverride || '';
}

/* =========================================================
   Correction flow ("Rätta med ny post") — a two-step wizard:
   1) a stornering (reversal) that zeroes out the original entry
   2) immediately after, a prefilled re-entry with the original's fields
      (dates, amounts, party, ...) so fixing e.g. a wrong date/quarter is
      just "change the one field and bokför" instead of retyping everything.
   Neither step ever touches the original entry itself.
   ========================================================= */
function correctEntry(id) {
  const orig = findLedgerById(id);
  if (!orig) return;
  const msg = `Detta bokför en stornering (nollställer) verifikation #${orig.verNr}.\n\n` +
    `Den ursprungliga posten ändras eller tas INTE bort — så kräver bokföringslagen. ` +
    `Direkt efter får du ange den korrekta versionen (t.ex. med rätt datum om den hamnade i fel kvartal).\n\nFortsätta?`;
  if (!confirm(msg)) return;
  formDraft = {
    kind: 'correction-reversal',
    correctionOf: orig.id,
    originalEntry: orig,
    type: orig.type,
    txDate: new Date().toISOString().slice(0, 10),
    party: orig.party,
    desc: `Rättelse (stornering) av verifikation #${orig.verNr}: ${orig.desc}`,
    gross: -orig.gross,
    rate: orig.rate,
    account: orig.account,
    reverse: orig.reverse,
    bannerText: `🔧 Steg 1/2: Nollställer verifikation #${orig.verNr} (stornering). Kontrollera och bokför.`,
  };
  navTo('kvitton');
  applyFormDraft();
}

function applyFormDraft() {
  if (!formDraft) return;
  const form = document.getElementById('receiptForm');
  const banner = document.getElementById('correctionBanner');
  banner.hidden = false;
  banner.textContent = formDraft.bannerText || '';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.className = 'corr-cancel'; cancelBtn.textContent = 'Avbryt';
  cancelBtn.addEventListener('click', clearFormDraft);
  banner.appendChild(document.createElement('br'));
  banner.appendChild(cancelBtn);

  form.type.value = formDraft.type;
  updateFormForType();
  if (formDraft.txDate) form.date.value = formDraft.txDate;
  if (formDraft.party != null) form.party.value = formDraft.party;
  if (formDraft.desc != null) form.desc.value = formDraft.desc;
  form.amount.value = formDraft.gross;
  if (formDraft.rate != null) form.rate.value = String(formDraft.rate);
  if (formDraft.account) form.account.value = formDraft.account;
  document.getElementById('rfReverse').checked = !!formDraft.reverse;
  updateReverseLock();
  updateCalcPreview();
  document.getElementById('rfAmount').focus();
}

function clearFormDraft() {
  formDraft = null;
  const banner = document.getElementById('correctionBanner');
  banner.hidden = true; banner.textContent = '';
  document.getElementById('receiptForm').reset();
  updateFormForType();
  document.getElementById('rfDate').value = new Date().toISOString().slice(0, 10);
  updateCalcPreview();
}

/* =========================================================
   Actions
   ========================================================= */
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
  document.querySelectorAll('[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  window.scrollTo(0, 0);
}

function setupNav() {
  document.querySelectorAll('[data-view]').forEach(n =>
    n.addEventListener('click', (e) => { e.preventDefault(); navTo(n.dataset.view); }));
  document.querySelectorAll('[data-goto]').forEach(b =>
    b.addEventListener('click', () => navTo(b.dataset.goto)));
  const start = (location.hash || '#oversikt').slice(1);
  navTo(['oversikt', 'kvitton', 'kalkylator', 'deklaration', 'anteckningar', 'installningar'].includes(start) ? start : 'oversikt');
}

function updateFormForType() {
  const form = document.getElementById('receiptForm');
  const type = form.type.value;
  const isCapital = type === 'insattning' || type === 'uttag';
  const isSale = type === 'forsaljning';

  document.getElementById('rfPartyField').classList.toggle('is-optional', isCapital);
  form.party.required = !isCapital;
  document.querySelector('#rfPartyField label').innerHTML =
    isCapital ? 'Motpart <span class="muted small">(t.ex. bank, valfritt)</span>' : 'Motpart <span class="muted small">(kund/leverantör)</span>';

  document.getElementById('rfRateField').hidden = isCapital;
  document.getElementById('rfReverseField').hidden = isCapital || isSale;
  if (isCapital) document.getElementById('rfReverse').checked = false;

  document.getElementById('rfAmountLabel').textContent = isCapital ? 'Belopp' : 'Bruttobelopp (inkl. moms)';

  const accSel = form.account;
  const keepVal = accSel.value;
  accSel.innerHTML = Object.entries(ACCOUNTS)
    .filter(([code]) => !(isCapital && code === 'privat'))
    .map(([code, label]) => `<option value="${code}">${label}</option>`).join('');
  accSel.value = Object.prototype.hasOwnProperty.call(ACCOUNTS, keepVal) && accSel.querySelector(`option[value="${keepVal}"]`) ? keepVal : 'firmakonto';

  updateReverseLock();
}

function updateReverseLock() {
  const rate = document.getElementById('rfRate');
  const reverse = document.getElementById('rfReverse');
  if (reverse.hidden || reverse.closest('#rfReverseField').hidden) return;
  if (reverse.checked) { rate.value = '0'; rate.disabled = true; }
  else { rate.disabled = false; }
}

function readFormInputs(form) {
  return {
    type: form.type.value,
    txDate: form.date.value,
    party: form.party.value.trim(),
    desc: form.desc.value.trim(),
    gross: parseFloat(String(form.amount.value).replace(',', '.')) || 0,
    rate: Number(form.rate.value),
    account: form.account.value,
    reverse: !document.getElementById('rfReverseField').hidden && document.getElementById('rfReverse').checked,
    ref: form.ref.value.trim(),
    note: form.note.value.trim(),
  };
}

function updateCalcPreview() {
  updateDateConfirm('rfDate', 'rfDateConfirm');
  const form = document.getElementById('receiptForm');
  const v = readFormInputs(form);
  const isCapital = v.type === 'insattning' || v.type === 'uttag';
  const preview = document.getElementById('calcPreview');
  if (isCapital) {
    preview.innerHTML = `<span>Ingen moms — påverkar inte momsen eller resultatet.</span>`;
    return;
  }
  const rate = v.reverse ? 0 : v.rate;
  const { net, vat } = vatFromGross(v.gross, rate);
  let html = `<span>Nettobelopp: <strong>${kr(net)}</strong></span>` +
    `<span>Moms: <strong>${kr(vat)}</strong></span>` +
    `<span>Brutto: <strong>${kr(v.gross)}</strong></span>`;
  if (v.reverse) html += `<span>+ Omvänd moms 25 %: <strong>${kr(net * 0.25)}</strong> (rutorna 21/30/48)</span>`;
  preview.innerHTML = html;
}

function setupReceiptForm() {
  const form = document.getElementById('receiptForm');
  const dateEl = document.getElementById('rfDate');
  dateEl.value = new Date().toISOString().slice(0, 10);

  form.type.addEventListener('change', () => { updateFormForType(); updateCalcPreview(); });
  document.getElementById('rfReverse').addEventListener('change', () => { updateReverseLock(); updateCalcPreview(); });
  form.addEventListener('input', updateCalcPreview);
  updateFormForType();
  updateCalcPreview();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = readFormInputs(form);
    const prevDraft = formDraft; // capture before we clear it below
    const isCorrectionReversal = !!(prevDraft && prevDraft.kind === 'correction-reversal');
    if (v.gross === 0) { toast('Fyll i ett belopp'); return; }
    if (!isCorrectionReversal && v.gross < 0) { toast('Beloppet ska vara positivt. Använd "Rätta" på posten du vill korrigera.'); return; }
    const isCapital = v.type === 'insattning' || v.type === 'uttag';
    if (!isCapital && !v.party) { toast('Motpart krävs för försäljning/inköp'); form.party.focus(); return; }
    if (!v.desc) { toast('Fyll i vad det avser'); form.desc.focus(); return; }

    const fileData = await compressImage(form.file.files[0]);
    const entry = addLedgerEntry({
      type: v.type, txDate: v.txDate, party: v.party, desc: v.desc,
      gross: v.gross, rate: v.rate, account: v.account, reverse: v.reverse,
      ref: v.ref, fileData, note: v.note,
      correctionOf: prevDraft && prevDraft.correctionOf ? prevDraft.correctionOf : null,
    });

    if (prevDraft && prevDraft.calcId) {
      const c = state.calculations.find(x => x.id === prevDraft.calcId);
      if (c) c.bookedId = entry.id;
    }
    formDraft = null;
    document.getElementById('correctionBanner').hidden = true;

    save();
    form.reset();
    updateFormForType();
    updateCalcPreview();

    // Jump to the period the new entry lands in, so it's never invisible.
    const k = currentPeriodKey(state.settings.period, new Date(entry.txDate + 'T00:00:00'));
    state.activePeriod = (k === currentPeriodKey(state.settings.period)) ? null : k;
    save();
    renderAll();

    if (isCorrectionReversal && prevDraft.originalEntry) {
      // Chain straight into step 2: prefill a normal, positive re-entry with
      // the original's fields so the user only has to fix what was wrong
      // (e.g. the date) instead of retyping everything.
      const orig = prevDraft.originalEntry;
      toast(`Steg 1/2 klart: stornering bokförd som #${entry.verNr}. Nu: ange rätt version.`, 4000);
      formDraft = {
        kind: 'correction-reentry',
        correctionOf: orig.id,
        type: orig.type,
        txDate: orig.txDate,
        party: orig.party,
        desc: orig.desc,
        gross: orig.gross,
        rate: orig.rate,
        account: orig.account,
        reverse: orig.reverse,
        bannerText: `📋 Steg 2/2: Innehållet från verifikation #${orig.verNr} är förifyllt. Ändra det som var fel (t.ex. datumet) och bokför. Steg 1 (stornering) är redan bokfört och kan inte ångras här — "Avbryt" hoppar bara över steg 2.`,
      };
      applyFormDraft();
    } else {
      dateEl.value = new Date().toISOString().slice(0, 10);
      updateCalcPreview();
      toast(`Verifikation #${entry.verNr} bokförd ✓`);
    }
  });
  form.addEventListener('reset', () => {
    formDraft = null;
    document.getElementById('correctionBanner').hidden = true;
    setTimeout(() => { updateFormForType(); updateCalcPreview(); }, 0);
  });
}

function setupCalculator() {
  const amount = document.getElementById('cAmount');
  const rate = document.getElementById('cRate');
  const what = document.getElementById('cWhat');
  const dateEl = document.getElementById('cDate');
  const view = document.getElementById('view-kalkylator');
  dateEl.value = new Date().toISOString().slice(0, 10);

  const read = () => ({
    gross: parseFloat(String(amount.value).replace(',', '.')) || 0,
    rate: Number(rate.value),
    type: view.querySelector('input[name="ctype"]:checked').value,
    label: what.value.trim() || 'Uträkning',
    date: dateEl.value || new Date().toISOString().slice(0, 10),
  });
  const update = () => {
    updateDateConfirm('cDate', 'cDateConfirm');
    const v = read();
    const { net, vat } = vatFromGross(v.gross, v.rate);
    document.getElementById('cExcl').textContent = kr(net);
    document.getElementById('cVat').textContent = kr(vat);
    document.getElementById('cTotal').textContent = kr(v.gross);
    document.getElementById('cRateLbl').textContent = `(${v.rate} %)`;
    const ctx = document.getElementById('cContext');
    const isInkop = v.type === 'inkop';
    document.getElementById('cContextLabel').textContent = isInkop ? 'Moms att få tillbaka' : 'Moms att betala';
    document.getElementById('cContextVal').textContent = kr(vat);
    ctx.classList.toggle('is-refund', isInkop);
    ctx.classList.toggle('is-pay', !isInkop);
  };
  view.addEventListener('input', update);
  view.addEventListener('change', update);
  update();

  document.getElementById('calcSave').addEventListener('click', () => {
    const v = read();
    if (!(v.gross > 0)) { toast('Fyll i ett belopp'); amount.focus(); return; }
    const { net, vat } = vatFromGross(v.gross, v.rate);
    state.calculations.push({
      id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
      ts: Date.now(), date: v.date, label: v.label, type: v.type,
      gross: v.gross, rate: v.rate, net, vat, bookedId: null,
    });
    save();
    amount.value = ''; what.value = '';
    dateEl.value = new Date().toISOString().slice(0, 10);
    update(); renderCalcList();
    toast('Uträkning sparad ✓');
  });
}

function setupReportToggle() {
  document.querySelectorAll('.report-toggle button').forEach(b => {
    b.addEventListener('click', () => { reportRangeMode = b.dataset.range; renderSummaryPanel(); });
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
    a.download = `moms-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

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
        if (!incoming || typeof incoming !== 'object' || !(Array.isArray(incoming.ledger) || Array.isArray(incoming.receipts))) {
          toast('Det där ser inte ut som en Moms-datafil.'); return;
        }
        const hasData = state.ledger.length || state.calculations.length || state.notes;
        if (hasData && !confirm('Den här enheten har redan data. Ersätta den med filens innehåll?')) return;
        state = migrateState(incoming);
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
      btn.innerHTML = `<span>${periodLabel(state.settings.period, key)}</span><span class="muted small">deadline ${dl.getDate()}/${dl.getMonth() + 1}</span>`;
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
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
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

async function syncPullApply() {
  if (!syncCfg || syncBusy) return;
  try {
    const remote = await syncPull();
    if (remote && (remote.updatedAt || 0) > (state.updatedAt || 0)) {
      state = migrateState(remote);
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

  const remote = await syncPull().catch(() => null);
  const localHasData = state.ledger.length || state.calculations.length || state.notes;
  if (remote && (remote.ledger || remote.receipts || []).length && !localHasData) {
    state = migrateState(remote);
    save({ skipSync: true }); renderAll();
    toast('Hämtade din data från molnet ✓');
  } else if (remote && (remote.ledger || remote.receipts || []).length && localHasData) {
    const useCloud = confirm('Det finns redan data i molnet OCH på den här enheten.\n\nOK = använd molnets data (ersätter enhetens)\nAvbryt = skriv över molnet med den här enhetens data');
    if (useCloud) { state = migrateState(remote); save({ skipSync: true }); renderAll(); }
    else { await syncPush(); }
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
        (when ? ` · senast synkad ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '');
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
  document.querySelectorAll('.hint').forEach(h => h.addEventListener('click', () => toast(h.dataset.hint, 3500)));
}

/* ---------- Stripe CSV import ---------- */
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
  if (s.indexOf(',') > -1 && s.indexOf('.') > -1) s = s.replace(/,/g, '');
  else if (s.indexOf(',') > -1) s = s.replace(',', '.');
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

function findDate(headers) {
  for (const re of [/available.?on/, /created.*utc/, /^created/, /date.*utc/, /date/]) {
    const i = headers.findIndex(h => re.test(h) && !/due/.test(h));
    if (i > -1) return i;
  }
  return -1;
}

function findCust(headers) {
  const bad = /(amount|currency|facing|fee|net|gross|number|^id$|_id$|country|zip|postal)/;
  const good = [/customer.?email/, /customer.?name/, /card.?name/, /^customer$/, /^description$/, /statement.?descriptor/];
  for (const re of good) {
    const i = headers.findIndex(h => re.test(h) && !bad.test(h));
    if (i > -1) return i;
  }
  return -1;
}

function analyzeStripe(rows) {
  if (rows.length < 2) return { error: 'Filen verkar tom eller saknar rader.' };
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const find = (re) => headers.findIndex(h => re.test(h));
  const col = {
    id: find(/balance.?transaction|^id$|^charge.?id|source.?id/),
    cat: find(/reporting.?category|^type$/),
    date: findDate(headers),
    gross: find(/^gross$/),
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
    if (/payout/.test(cat)) continue;
    const a = amountFromRow(c);
    if (!a) continue;
    if (a.cur && a.cur.toUpperCase() !== 'SEK') curWarn = a.cur.toUpperCase();
    const id = col.id > -1 ? (c[col.id] || '') : '';
    const date = toIsoDate(col.date > -1 ? c[col.date] : '');
    if (a.gross > 0) {
      const fee = col.fee > -1 ? Math.abs(numSv(c[col.fee])) : 0;
      items.push({ kind: 'sale', id, date, gross: a.gross, fee, party: (col.cust > -1 ? (c[col.cust] || '') : '').trim() || 'Stripe-kund' });
    } else if (/fee/.test(cat)) {
      const amt = Math.abs(a.gross) || (col.fee > -1 ? Math.abs(numSv(c[col.fee])) : 0);
      if (amt > 0) items.push({ kind: 'fee', id, date, fee: amt });
    }
  }
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
      const newItems = res.items.filter(i => !isDupe(i));
      const newSales = newItems.filter(i => i.kind === 'sale');
      const dupes = res.items.length - newItems.length;
      const totGross = newSales.reduce((s, i) => s + (i.gross || 0), 0);
      const totFee = newItems.reduce((s, i) => s + (i.fee || 0), 0);
      const blockImport = !!res.curWarn;
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
        <div class="imp-stat"><span>Försäljningar ${blockImport ? 'i filen' : 'att skapa'}</span><strong>${(blockImport ? res.items.filter(i => i.kind === 'sale') : newSales).length} st</strong></div>
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
    let made = 0, skipped = 0, lastSaleDate = null;
    for (const it of pendingImport) {
      if (it.id && state.importedIds[it.id]) { skipped++; continue; }
      if (it.kind === 'fee') {
        if (incFees && it.fee > 0) {
          addLedgerEntry({
            type: 'inkop', txDate: it.date, party: 'Stripe', desc: 'Stripe-avgift',
            gross: it.fee, rate: 0, account: 'firmakonto', reverse: true, ref: it.id,
            note: 'Importerad från Stripe · EU-tjänst, omvänd skattskyldighet 25 %', source: 'stripe',
          });
        }
      } else {
        addLedgerEntry({
          type: 'forsaljning', txDate: it.date, party: it.party, desc: 'Stripe-försäljning',
          gross: it.gross, rate, account: 'firmakonto', ref: it.id,
          note: 'Importerad från Stripe', source: 'stripe',
        });
        if (incFees && it.fee > 0) {
          addLedgerEntry({
            type: 'inkop', txDate: it.date, party: 'Stripe', desc: 'Stripe-avgift',
            gross: it.fee, rate: 0, account: 'firmakonto', reverse: true, ref: it.id,
            note: 'Importerad från Stripe · EU-tjänst, omvänd skattskyldighet 25 %', source: 'stripe',
          });
        }
        lastSaleDate = it.date;
      }
      if (it.id) state.importedIds[it.id] = true;
      made++;
    }
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

/* =========================================================
   Export: accountant report (period), full CSV, SIE
   ========================================================= */
function accountLabel(code) { return ACCOUNTS[code] || code || '—'; }

function buildQuarterReport() {
  const t = summaryTotals(ledgerInPeriod());
  const dl = state.settings.deadlineOverride
    ? new Date(state.settings.deadlineOverride + 'T00:00:00')
    : deadlineFor(state.settings.period, activeKey());
  const dlStr = `${dl.getDate()} ${MONTHS[dl.getMonth()]} ${dl.getFullYear()}`;
  const rs = ledgerInPeriod();
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
    L('Resultat (informativt)', ''),
    L('Intäkter, netto', Math.round(t.sales)),
    L('Kostnader, netto', Math.round(t.costNet)),
    L('Resultat', Math.round(t.result)),
    L('Egna insättningar', Math.round(t.insattningar)),
    L('Egna uttag', Math.round(t.uttag)),
    '',
    L(`Verifikationer (${rs.length} st)`),
    L('Vernr', 'Transaktionsdatum', 'Bokfört', 'Typ', 'Motpart', 'Vad avser', 'Bruttobelopp', 'Momssats', 'Nettobelopp', 'Momsbelopp', 'Konto', 'Referens', 'Rättelse av', 'Anteckning'),
    ...rs.map(r => L(
      r.verNr, r.txDate, (r.createdAt || '').slice(0, 16).replace('T', ' '),
      r.type === 'forsaljning' ? 'Försäljning' : r.type === 'inkop' ? (r.reverse ? 'Inköp (EU omvänd moms)' : 'Inköp') : TYPE_LABEL[r.type],
      r.party, r.desc, r.gross.toFixed(2),
      (r.type === 'insattning' || r.type === 'uttag') ? '—' : (r.reverse ? 'omvänd 25%' : r.rate + '%'),
      r.net.toFixed(2), r.vat.toFixed(2), accountLabel(r.account), r.ref || '',
      r.correctionOf ? ('#' + (findLedgerById(r.correctionOf)?.verNr ?? '?')) : '',
      r.note || ''
    )),
  ];
  return '﻿' + lines.join('\r\n');
}

function quarterFilename() {
  const safe = (state.settings.name || 'moms').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'moms';
  return `momsunderlag-${safe}-${activeKey()}.csv`;
}

// "Exportera alla poster till CSV" — the full, unfiltered ledger, forever.
function buildFullLedgerCsv() {
  const L = (...c) => c.map(csvCell).join(';');
  const rows = ledgerSorted();
  const header = L('Vernr', 'Transaktionsdatum', 'Bokfört', 'Typ', 'Motpart', 'Vad avser', 'Bruttobelopp', 'Momssats', 'Nettobelopp', 'Momsbelopp', 'Betalsätt/konto', 'Referens', 'Rättelse av', 'Anteckning');
  const typeLabel = (e) => e.type === 'forsaljning' ? 'Försäljning' : e.type === 'inkop' ? (e.reverse ? 'Inköp (EU omvänd moms)' : 'Inköp') : TYPE_LABEL[e.type];
  const lines = rows.map(e => L(
    e.verNr, e.txDate, (e.createdAt || '').slice(0, 16).replace('T', ' '),
    typeLabel(e), e.party, e.desc, e.gross.toFixed(2),
    (e.type === 'insattning' || e.type === 'uttag') ? '—' : (e.reverse ? 'omvänd 25%' : e.rate + '%'),
    e.net.toFixed(2), e.vat.toFixed(2), accountLabel(e.account), e.ref || '',
    e.correctionOf ? ('#' + (findLedgerById(e.correctionOf)?.verNr ?? '?')) : '',
    e.note || ''
  ));
  return '﻿' + [header, ...lines].join('\r\n');
}

function fullCsvFilename() {
  const safe = (state.settings.name || 'moms').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'moms';
  return `verifikationer-alla-${safe}.csv`;
}

/* ---------- SIE4 export (simplified BAS-like account mapping) ---------- */
const SIE_ACCOUNTS = {
  '1930': 'Företagskonto', '1910': 'Kassa',
  '2018': 'Egna insättningar', '2013': 'Egna uttag',
  '3001': 'Försäljning 25% moms', '3002': 'Försäljning 12% moms', '3003': 'Försäljning 6% moms', '3004': 'Försäljning momsfri',
  '2610': 'Utgående moms 25%', '2620': 'Utgående moms 12%', '2630': 'Utgående moms 6%',
  '4000': 'Inköp varor/tjänster', '2640': 'Ingående moms',
  '2645': 'Ingående moms, omvänd skattskyldighet', '2614': 'Utgående moms, omvänd skattskyldighet',
};

function sieLinesForEntry(e) {
  const cash = e.account === 'kontant' ? '1910' : '1930';
  if (e.type === 'insattning') return [[cash, e.gross], ['2018', -e.gross]];
  if (e.type === 'uttag') return [['2013', e.gross], [cash, -e.gross]];
  const counter = e.account === 'privat' ? '2018' : cash;
  if (e.type === 'forsaljning') {
    const salesAcc = e.rate === 25 ? '3001' : e.rate === 12 ? '3002' : e.rate === 6 ? '3003' : '3004';
    const vatAcc = e.rate === 25 ? '2610' : e.rate === 12 ? '2620' : e.rate === 6 ? '2630' : null;
    const lines = [[cash, e.gross], [salesAcc, -e.net]];
    if (vatAcc && e.vat) lines.push([vatAcc, -e.vat]);
    return lines;
  }
  if (e.reverse) {
    const rv = e.net * 0.25;
    return [['4000', e.net], ['2645', rv], [counter, -e.gross], ['2614', -rv]];
  }
  const lines = [['4000', e.net], [counter, -e.gross]];
  if (e.vat) lines.push(['2640', e.vat]);
  return lines;
}

// Swedish letters via CP437 (the SIE-standard encoding) — a small lookup is
// enough since ledger text is Swedish; anything else falls back to '?'.
const CP437_MAP = { 'å': 0x86, 'ä': 0x84, 'ö': 0x94, 'Å': 0x8F, 'Ä': 0x8E, 'Ö': 0x99, 'é': 0x82, 'è': 0x8A, 'ü': 0x81, 'É': 0x90 };
function toCp437Bytes(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code < 128) bytes.push(code);
    else if (CP437_MAP[ch] !== undefined) bytes.push(CP437_MAP[ch]);
    else bytes.push(0x3F);
  }
  return new Uint8Array(bytes);
}

function buildSie(rangeMode) {
  const entries = ledgerInRange(rangeMode).slice().sort((a, b) => a.verNr - b.verNr);
  let range = reportRangeDates(rangeMode);
  if (!range) {
    if (!entries.length) {
      const y = new Date().getFullYear();
      range = { start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
    } else {
      const dates = entries.map(e => e.txDate).sort();
      range = { start: new Date(dates[0] + 'T00:00:00'), end: new Date(dates[dates.length - 1] + 'T00:00:00') };
    }
  }
  const fmtD = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const sieStr = (s) => '"' + String(s || '').replace(/"/g, '') + '"';
  const usedAccounts = new Set();
  entries.forEach(e => sieLinesForEntry(e).forEach(([acc]) => usedAccounts.add(acc)));

  const lines = [];
  lines.push('#FLAGGA 0');
  lines.push(`#PROGRAM ${sieStr('Moms - personligt bokforingsunderlag')} "1.0"`);
  lines.push('#FORMAT PC8');
  lines.push(`#GEN ${fmtD(new Date())}`);
  lines.push('#SIETYP 4');
  if (state.settings.name) lines.push(`#FNAMN ${sieStr(state.settings.name)}`);
  if (state.settings.org) lines.push(`#ORGNR ${sieStr(state.settings.org)}`);
  lines.push(`#RAR 0 ${fmtD(range.start)} ${fmtD(range.end)}`);
  [...usedAccounts].sort().forEach(acc => lines.push(`#KONTO ${acc} ${sieStr(SIE_ACCOUNTS[acc] || acc)}`));

  for (const e of entries) {
    const text = e.party ? `${e.desc} - ${e.party}` : e.desc;
    const regDate = (e.createdAt || e.txDate).slice(0, 10);
    lines.push(`#VER "A" "${e.verNr}" ${fmtD(new Date(e.txDate + 'T00:00:00'))} ${sieStr(text)} ${fmtD(new Date(regDate + 'T00:00:00'))}`);
    lines.push('{');
    for (const [acc, amt] of sieLinesForEntry(e)) lines.push(`   #TRANS ${acc} {} ${amt.toFixed(2)}`);
    lines.push('}');
  }
  return lines.join('\r\n');
}

function sieFilename(mode) {
  const safe = (state.settings.name || 'moms').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'moms';
  return `verifikationer-${safe}-${mode}.sie`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function setupExport() {
  const download = () => {
    downloadBlob(new Blob([buildQuarterReport()], { type: 'text/csv;charset=utf-8' }), quarterFilename());
    toast('Filen laddades ner ✓');
  };

  const share = async () => {
    const csv = buildQuarterReport();
    const fname = quarterFilename();
    const period = periodLabel(state.settings.period, activeKey());
    try {
      const file = new File([csv], fname, { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Momsunderlag ${period}`, text: `Momsunderlag för ${period}${state.settings.name ? ' – ' + state.settings.name : ''}.` });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    download();
    toast('Delning stöds inte här — filen laddades ner. Bifoga den i ett sms eller mejl.', 4000);
  };

  document.querySelectorAll('.js-share').forEach(b => b.addEventListener('click', share));
  document.getElementById('downloadBtn').addEventListener('click', download);

  document.getElementById('exportAllCsvBtn').addEventListener('click', () => {
    if (!state.ledger.length) { toast('Inga verifikationer att exportera än'); return; }
    downloadBlob(new Blob([buildFullLedgerCsv()], { type: 'text/csv;charset=utf-8' }), fullCsvFilename());
    toast('Alla verifikationer exporterade ✓');
  });

  document.getElementById('exportSieBtn').addEventListener('click', () => {
    if (!ledgerInRange(reportRangeMode).length) { toast('Inga verifikationer i det här intervallet'); return; }
    const bytes = toCp437Bytes(buildSie(reportRangeMode));
    downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), sieFilename(reportRangeMode));
    toast('SIE-fil exporterad — kontrollera kontona innan import i Bokio m.fl. ✓', 4000);
  });
}

/* ---------- Small utils ---------- */
function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function csvCell(s) { s = String(s); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function fmtDate(iso) { const d = new Date(iso + 'T00:00:00'); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; }

// Full, unambiguous Swedish date readback — shown next to date inputs so a
// misread native date-picker (which renders in the OS/browser locale, e.g.
// MM/DD/YYYY) never silently books the wrong day/quarter without the user
// noticing.
function fmtDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '';
  return `→ ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function updateDateConfirm(dateInputId, confirmId) {
  const confirmEl = document.getElementById(confirmId);
  const dateEl = document.getElementById(dateInputId);
  if (!confirmEl || !dateEl) return;
  confirmEl.textContent = fmtDateLong(dateEl.value);
}
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
  setupReportToggle();
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

  if (state._migratedNotice) {
    delete state._migratedNotice;
    save();
    toast('Dina verifikationsnummer har uppdaterats till en obruten löpnummerserie enligt bokföringslagen.', 5000);
  } else if (!state.settings.name && !state.ledger.length) {
    toast('Välkommen! Ställ in din period under Inställningar ⚙', 3500);
  }
}
document.addEventListener('DOMContentLoaded', boot);
