'use strict';
/* ================= Данные ================= */
const VIEWER = !!window.VIEWER;   // режим начальника: только просмотр
const KEY = VIEWER ? 'buh.view.v1' : 'buh.v1', UIKEY = VIEWER ? 'buh.view.ui' : 'buh.ui';
const COLS = ['points', 'employees', 'registers', 'food', 'advances', 'cash', 'photos', 'products', 'stock', 'cats', 'fines'];
const BOSS = '__boss', BOSS_NAME = 'Знакомые начальника';

const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
const money = n => Math.round(n).toLocaleString('ru-RU');
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (m, n) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); };
const sum = (arr, k) => arr.reduce((s, x) => s + num(x[k]), 0);
const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
const stamp = o => (o.updatedAt = Date.now(), o);
const today = () => iso(new Date());

const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const WD = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const fmtDay = s => { const d = parseIso(s); return WD[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_GEN[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''); };
const fmtShort = s => s.slice(8, 10) + '.' + s.slice(5, 7);
const fmtMonth = m => { const [y, mm] = m.split('-').map(Number); return MONTHS[mm - 1] + ' ' + y; };

// deleted — пометки об удалении для синхронизации; sync — что уже отправлено/получено
function emptyDb() { return { version: 2, points: [], employees: [], registers: [], food: [], advances: [], cash: [], photos: [], products: [], stock: [], cats: [], fines: [], deleted: [], lastBackup: 0, sync: { lastPush: 0, pull: {} } }; }
function normalizeDb(d) {
  d = Object.assign(emptyDb(), d);
  if (!d.sync || typeof d.sync !== 'object') d.sync = { lastPush: 0, pull: {} };
  if (!d.sync.pull) d.sync.pull = {};
  if (!Array.isArray(d.deleted)) d.deleted = [];
  const now = Date.now();
  COLS.forEach(c => { if (!Array.isArray(d[c])) d[c] = []; d[c].forEach(r => { if (!r.updatedAt) r.updatedAt = now; }); });
  d.version = 2;
  return d;
}
function loadDb() {
  try { const r = localStorage.getItem(KEY); if (r) return normalizeDb(JSON.parse(r)); } catch (e) {}
  return emptyDb();
}
let db = loadDb();
function save(fromCloud) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Ошибка: не удалось сохранить!'); }
  if (!fromCloud && !VIEWER && window.Sync) window.Sync.schedulePush();
}
// Удаление записи с пометкой, чтобы удаление дошло и до облака
// Копия записи (rec) хранится 30 дней — из неё работает «Корзина».
function removeRec(col, rec) {
  db[col] = db[col].filter(x => x !== rec);
  const snap = Object.assign({}, rec); delete snap.syncedAt;
  db.deleted.push({ col, id: rec.id, updatedAt: Date.now(), rec: snap });
}
// Вернуть запись из корзины (вместе с фото, если это запись налички)
function restoreRec(t) {
  if (!t.rec || db[t.col].some(x => x.id === t.id)) return false;
  db[t.col].push(stamp(Object.assign({}, t.rec)));
  db.deleted = db.deleted.filter(x => x !== t);
  if (t.col === 'photos') unDeletePhoto(t.id);
  if (t.col === 'cash') db.deleted.filter(x => x.col === 'photos' && x.rec && x.rec.cashId === t.id).forEach(restoreRec);
  return true;
}
const MONTH_MS = 30 * 864e5;

// Принять записи из облака: побеждает более свежая правка
function applyRemote(col, docs) {
  let changed = false;
  docs.forEach(d => {
    const list = db[col];
    const i = list.findIndex(x => x.id === d.id);
    const local = i >= 0 ? list[i] : null;
    if (d.deleted) {
      if (local && (local.updatedAt || 0) <= d.updatedAt) { list.splice(i, 1); changed = true; }
      return;
    }
    const tomb = db.deleted.find(x => x.col === col && x.id === d.id);
    if (tomb && tomb.updatedAt >= d.updatedAt) return;
    const rec = Object.assign({}, d, { syncedAt: d.updatedAt }); delete rec.deleted;
    if (!local) { list.push(rec); changed = true; }
    else if ((local.updatedAt || 0) < d.updatedAt) { list[i] = rec; changed = true; }
  });
  return changed;
}

let syncState = { enabled: !!window.FIREBASE_CONFIG, checking: !!window.FIREBASE_CONFIG, user: null, status: 'off', error: '', lastOk: 0 };
window.App = {
  VIEWER, COLS,
  get db() { return db; },
  applyRemote(col, docs) { const ch = applyRemote(col, docs); if (ch) { save(true); safeRender(); } return ch; },
  saveSyncMeta() { save(true); },
  setSync(s) { Object.assign(syncState, s); safeRender(); },
  resetLocal() { db = emptyDb(); save(true); PDB.clear().catch(() => {}); render(); },
  photoQueue: () => PDB.all().then(a => a.filter(x => !x.synced)),
  // Удалённое фото оставляем в телефоне на 30 дней (для корзины), в облаке оно помечено удалённым
  photoSynced: p => PDB.put(Object.assign({}, p, { synced: true })),
  toast: m => toast(m),
};

let ui = { tab: 'day', pointId: '', payPoint: 'all', date: today(), month: today().slice(0, 7), foodWho: '', advWho: '' };
try { Object.assign(ui, JSON.parse(localStorage.getItem(UIKEY)) || {}); } catch (e) {}
ui.date = today(); ui.month = today().slice(0, 7);
function saveUi() { try { localStorage.setItem(UIKEY, JSON.stringify({ tab: ui.tab, pointId: ui.pointId, payPoint: ui.payPoint })); } catch (e) {} }

const point = id => db.points.find(p => p.id === id);
const pointName = id => point(id)?.name || '(точка удалена)';
const emp = id => db.employees.find(e => e.id === id);
const empName = id => id === BOSS ? BOSS_NAME : (emp(id)?.name || '(удалён)');
const pointEmps = (pid, withArchived) => db.employees.filter(e => e.pointId === pid && (withArchived || !e.archived)).sort(byName);
const getReg = (d, pid) => db.registers.find(r => r.date === d && r.pointId === pid);
const sortedPoints = () => [...db.points].sort(byName);

function ensurePoint() {
  if (!point(ui.pointId)) ui.pointId = sortedPoints()[0]?.id || '';
  if (ui.payPoint !== 'all' && !point(ui.payPoint)) ui.payPoint = 'all';
}

/* ================= Расчёты ================= */
// Общая наличка: по дням со всех точек. Аванс тоже выдаётся из налички.
function cashTimeline() {
  const days = {};
  const g = d => days[d] || (days[d] = { cash: 0, added: 0, expense: 0, advance: 0, salary: 0, entries: [], advs: [], pays: [] });
  db.cash.forEach(c => { const x = g(c.date); x.cash += num(c.cash); x.added += num(c.added); x.expense += num(c.expense); x.entries.push(c); });
  db.advances.forEach(a => { const x = g(a.date); x.advance += num(a.amount); x.advs.push(a); });
  // Выданная зарплата, если её выдали из налички
  db.employees.forEach(e => Object.entries(e.paid || {}).forEach(([m, p]) => {
    if (!p || !p.fromCash || !p.date) return;
    const x = g(p.date); x.salary += num(p.amount); x.pays.push({ e, m, amount: num(p.amount) });
  }));
  const dates = Object.keys(days).sort();
  let run = 0;
  dates.forEach(d => { const x = days[d]; run += x.cash + x.added - x.expense - x.advance - x.salary; x.balance = run; });
  return { days, dates };
}

/* ---------- Зарплата: оклад по месяцам и отработанные дни ---------- */
// salaryHist: [{ from: 'YYYY-MM', amount }] — с какого месяца действует оклад
function salaryFor(e, m) {
  const h = Array.isArray(e.salaryHist) ? e.salaryHist.filter(x => x.from <= m).sort((a, b) => a.from.localeCompare(b.from)) : [];
  return h.length ? num(h[h.length - 1].amount) : num(e.salary);
}
// Сколько дней месяца человек работал (по датам «начал» и «уволен»)
function workDays(e, m) {
  const [y, mm] = m.split('-').map(Number), dim = new Date(y, mm, 0).getDate();
  const first = m + '-01', last = m + '-' + pad(dim);
  const s = e.hired && e.hired > first ? e.hired : first;
  const f = e.fired && e.fired < last ? e.fired : last;
  const days = s > f ? 0 : Math.round((parseIso(f) - parseIso(s)) / 864e5) + 1;
  return { days, dim };
}
function accrued(e, m) {
  const w = workDays(e, m);
  return { amount: salaryFor(e, m) * w.days / w.dim, full: salaryFor(e, m), days: w.days, dim: w.dim };
}
function balanceAt(date, t) {
  let b = 0;
  for (const d of t.dates) { if (d > date) break; b = t.days[d].balance; }
  return b;
}
// Дни, где чек не совпадает с суммой питания по людям
function checkIssues() {
  const res = {}, fs = {}, key = (d, p) => d + '|' + p;
  db.food.forEach(f => { const k = key(f.date, f.pointId); fs[k] = (fs[k] || 0) + num(f.amount); });
  const keys = new Set([...db.registers.filter(r => num(r.check)).map(r => key(r.date, r.pointId)), ...Object.keys(fs)]);
  keys.forEach(k => {
    const [d, p] = k.split('|');
    const left = num(getReg(d, p)?.check) - (fs[k] || 0);
    if (Math.abs(left) > 0.5) (res[d] || (res[d] = [])).push({ pointId: p, left });
  });
  return res;
}

/* ================= Отрисовка ================= */
function render() {
  ensurePoint();
  document.body.classList.toggle('viewer', VIEWER);
  // Начальнику без входа показываем только экран входа
  const needLogin = VIEWER && !syncState.user;
  document.body.classList.toggle('locked', needLogin);
  if (needLogin) {
    $('#top').innerHTML = '<h1>Касса — отчёты</h1>';
    $('#main').innerHTML = viewLogin();
    return;
  }
  $('#top').innerHTML = topBar() + syncLine();
  $('#main').innerHTML = ({ day: viewDay, cash: viewCash, stock: viewStock, report: viewReport, pay: viewPay, more: viewMore })[ui.tab]();
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  hydratePhotos();
}
// Не перерисовываем, пока человек вводит текст — дождёмся, когда закончит
let renderPending = false;
function safeRender() {
  const a = document.activeElement;
  if (a && a.closest && a.closest('#main') && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { renderPending = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (!renderPending) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest('#main') && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
  renderPending = false; render();
}, 0));

function syncLine() {
  if (!syncState.enabled || !syncState.user) return '';
  const t = syncState.lastOk ? new Date(syncState.lastOk).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  const map = {
    ok: ['ok', '☁ Синхронизировано' + (t ? ' в ' + t : '')],
    busy: ['muted', '☁ Синхронизация…'],
    offline: ['warn', '☁ Нет интернета — отправим позже'],
    error: ['bad', '☁ Ошибка: ' + (syncState.error || 'нет связи')],
  };
  const [cls, txt] = map[syncState.status] || map.busy;
  return `<div class="syncline ${cls}">${esc(txt)}</div>`;
}

function viewLogin() {
  if (!syncState.enabled) return `<section class="card empty"><h3>Облако не настроено</h3><p>Попросите бухгалтера подключить облако.</p></section>`;
  if (syncState.checking) return `<section class="card empty"><p>Загрузка…</p></section>`;
  return `<section class="card"><h2>Вход</h2>
    <form data-form="login" class="stack">
      <label class="fld"><span>Почта</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="fld"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Войти</button>
      ${syncState.error ? `<p class="status bad">${esc(syncState.error)}</p>` : ''}
      <p class="sub">Забыли пароль? Обратитесь к бухгалтеру — он задаст новый.</p>
    </form></section>`;
}

function opts(list, val) { return list.map(o => `<option value="${esc(o.v)}"${o.v === val ? ' selected' : ''}>${esc(o.t)}</option>`).join(''); }
function pointSelect(val, withAll, change) {
  const list = sortedPoints().map(p => ({ v: p.id, t: p.name }));
  if (withAll) list.unshift({ v: 'all', t: 'Все точки' });
  return `<select class="pointsel" data-change="${change}" aria-label="Точка">${opts(list, val)}</select>`;
}
function monthNav() {
  return `<div class="datenav"><button data-act="prevMonth" aria-label="Предыдущий месяц">‹</button>
    <div class="datebtn">${fmtMonth(ui.month)}</div>
    <button data-act="nextMonth" aria-label="Следующий месяц">›</button></div>`;
}
function dayNav() {
  return `<div class="datenav"><button data-act="prevDay" aria-label="Предыдущий день">‹</button>
    <label class="datebtn">${fmtDay(ui.date)}${ui.date === today() ? '<span class="today">· сегодня</span>' : ''}
    <input type="date" value="${ui.date}" data-change="date" aria-label="Дата"></label>
    <button data-act="nextDay" aria-label="Следующий день">›</button></div>`;
}
function topBar() {
  if (ui.tab === 'day') {
    if (!db.points.length) return '<h1>Касса кафе</h1>';
    return pointSelect(ui.pointId, false, 'point') + dayNav();
  }
  if (ui.tab === 'cash') return '<h1>Общая наличка</h1>' + dayNav();
  if (ui.tab === 'stock') return '<h1>Склад</h1>' + dayNav();
  if (ui.tab === 'report') return '<h1>Отчёт</h1>' + monthNav();
  if (ui.tab === 'pay') return (db.points.length > 1 ? pointSelect(ui.payPoint, true, 'payPoint') : '<h1>Зарплата</h1>') + monthNav();
  return VIEWER ? '<h1>Ещё</h1>' : '<h1>Настройки</h1>';
}

function emptyState() {
  if (VIEWER) return `<section class="card empty"><h3>Пока нет данных</h3><p>Данные появятся, как только бухгалтер их внесёт.</p></section>`;
  return `<section class="card empty"><h3>Добро пожаловать!</h3>
    <p>Сначала добавьте точку (кафе) и сотрудников. Или перенесите данные из старого приложения.</p>
    <div class="stack"><button class="primary" data-act="addPoint">+ Добавить точку</button>
    <button data-act="tab" data-tab="more">Перенести старые данные</button></div></section>`;
}

/* ---------- День ---------- */
function regSum(d, pid) {
  const r = getReg(d, pid);
  return `<div id="regSum" class="total">Касса − чек = <b>${money(num(r?.register) - num(r?.check))}</b></div>`;
}
function splitInfo(d, pid) {
  const check = num(getReg(d, pid)?.check);
  const split = sum(db.food.filter(f => f.date === d && f.pointId === pid), 'amount');
  const left = check - split;
  let cls, txt;
  if (!check && !split) { cls = 'muted'; txt = VIEWER ? 'Чек не введён' : 'Введите чек в «Касса» и разделите его по людям'; }
  else if (Math.abs(left) < 0.5) { cls = 'ok'; txt = '✓ Чек разделён полностью'; }
  else if (left > 0) { cls = 'warn'; txt = 'Осталось разделить: <b>' + money(left) + '</b>'; }
  else { cls = 'bad'; txt = 'Разделено больше чека на <b>' + money(-left) + '</b>'; }
  return `<div id="splitInfo" class="status ${cls}">${check || split ? `Чек ${money(check)} · разделено ${money(split)}<br>` : ''}${txt}</div>`;
}
function peopleOpts(pid, withBoss, includeId) {
  const l = pointEmps(pid).map(e => ({ v: e.id, t: e.name }));
  if (withBoss) l.push({ v: BOSS, t: BOSS_NAME });
  if (includeId && !l.some(o => o.v === includeId)) l.unshift({ v: includeId, t: empName(includeId) });
  return l;
}
function cashLine(c) {
  const parts = [];
  if (num(c.cash)) parts.push('нал. ' + money(c.cash));
  if (num(c.added)) parts.push('+ ' + money(c.added));
  if (num(c.expense)) parts.push('− ' + money(c.expense));
  return parts.join(' · ') || '0';
}

function viewDay() {
  if (!db.points.length) return emptyState();
  const pid = ui.pointId, d = ui.date;
  const reg = getReg(d, pid);
  const foods = db.food.filter(f => f.date === d && f.pointId === pid);
  const advs = db.advances.filter(a => a.date === d && a.pointId === pid);
  const fins = db.fines.filter(x => x.date === d && x.pointId === pid);
  const dayPhotos = db.photos.filter(p => p.date === d && p.pointId === pid && !p.cashId);
  const people = peopleOpts(pid, false);
  const foodPeople = peopleOpts(pid, true);
  const noPeople = !people.length ? `<p class="status muted">У этой точки нет сотрудников. Добавьте их во вкладке «Ещё».</p>` : '';
  const val = v => v === '' || v == null ? '' : v;
  const t = cashTimeline();

  return `${backupBanner()}${missingBanner()}${reg && reg.closed ? '<p class="status muted">Отмечено как выходной. Внесите кассу, если точка работала.</p>' : ''}
  <section class="card"><h2>Касса</h2>
    ${VIEWER ? `<div class="stats">
      <div class="stat"><small>Счёт кассы</small><b>${money(num(reg?.register))}</b></div>
      <div class="stat"><small>Чек (на зарплату)</small><b>${money(num(reg?.check))}</b></div></div>` : `<div class="grid2">
      <label class="fld"><span>Счёт кассы</span><input inputmode="decimal" data-reg="register" value="${val(reg?.register)}" placeholder="0"></label>
      <label class="fld"><span>Чек (на зарплату)</span><input inputmode="decimal" data-reg="check" value="${val(reg?.check)}" placeholder="0"></label>
    </div>`}
    ${regSum(d, pid)}
  </section>

  <section class="card"><h2>Чек — кто ел <span class="badge">${foods.length}</span></h2>
    ${foods.map(f => `<button class="item" data-act="editFood" data-id="${f.id}"><span>${esc(empName(f.employeeId))}</span><span class="num">${money(f.amount)}</span></button>`).join('')}
    ${VIEWER ? (foods.length ? '' : '<p class="sub">Никого</p>') : `<form class="quick" data-form="food">
      <select name="who" aria-label="Кто">${opts(foodPeople, foodPeople.some(o => o.v === ui.foodWho) ? ui.foodWho : foodPeople[0]?.v)}</select>
      <input name="amount" inputmode="decimal" placeholder="Сумма" aria-label="Сумма" autocomplete="off">
      <button class="primary" aria-label="Добавить">+</button>
    </form>`}
    ${splitInfo(d, pid)}
  </section>

  <section class="card"><h2>Аванс <span class="num">${money(sum(advs, 'amount'))}</span></h2>
    ${advs.map(a => `<button class="item" data-act="editAdv" data-id="${a.id}"><span>${esc(empName(a.employeeId))}</span><span class="num">${money(a.amount)}</span></button>`).join('')}
    ${VIEWER ? (advs.length ? '' : '<p class="sub">Не выдавали</p>') : people.length ? `<form class="quick" data-form="adv">
      <select name="who" aria-label="Кому">${opts(people, people.some(o => o.v === ui.advWho) ? ui.advWho : people[0]?.v)}</select>
      <input name="amount" inputmode="decimal" placeholder="Сумма" aria-label="Сумма" autocomplete="off">
      <button class="primary" aria-label="Добавить">+</button>
    </form>` : noPeople}
  </section>

  <section class="card"><h2>Штраф <span class="num">${money(sum(fins, 'amount'))}</span></h2>
    ${fins.map(x => `<button class="item" data-act="editFine" data-id="${x.id}"><span>${esc(empName(x.employeeId))}${x.note ? `<span class="sub">${esc(x.note)}</span>` : ''}</span><span class="num">${money(x.amount)}</span></button>`).join('')}
    ${VIEWER ? (fins.length ? '' : '<p class="sub">Не было</p>') : people.length ? `<form class="stack" data-form="fine" style="margin-top:10px">
      <div class="quick" style="margin-top:0">
        <select name="who" aria-label="Кому">${opts(people, people.some(o => o.v === ui.fineWho) ? ui.fineWho : people[0]?.v)}</select>
        <input name="amount" inputmode="decimal" placeholder="Сумма" aria-label="Сумма" autocomplete="off">
        <button class="primary" aria-label="Добавить">+</button>
      </div>
      <input name="note" placeholder="Причина (опоздание, недостача…)" autocomplete="off">
    </form>` : noPeople}
    <p class="sub" style="margin-top:6px">Вычитается из зарплаты. Общую наличку не меняет.</p>
  </section>

  <button class="card item linkcard" data-act="tab" data-tab="cash">
    <span>Общая наличка на конец дня<span class="sub">Ввод налички — во вкладке «Наличка»</span></span>
    <span class="num">${money(balanceAt(d, t))} ›</span></button>

  <section class="card"><h2>Фото за день <span class="badge">${dayPhotos.length}</span></h2>
    ${dayPhotos.length ? photoGrid(dayPhotos) : `<p class="sub">${VIEWER ? 'Фото нет' : 'Чек-листы, накладные и всё, что нужно сохранить за этот день'}</p>`}
    ${VIEWER ? '' : `<label class="filebtn photobtn" style="margin-top:8px">📷 Добавить фото
      <input type="file" accept="image/*" multiple data-change="dayPhotos"></label>`}
  </section>`;
}

/* ---------- Наличка ---------- */
// Наличка общая на все точки: вводится один раз за день, без точки
function viewCash() {
  const t = cashTimeline(), d = ui.date, m = d.slice(0, 7), issues = checkIssues();
  const dayCash = db.cash.filter(c => c.date === d);
  const dayAdv = db.advances.filter(a => a.date === d);
  const dayCard = `<section class="card"><h2>${d === today() ? 'Сегодня' : fmtDay(d)}</h2>
    ${dayCash.map(c => `<button class="item" ${VIEWER ? '' : `data-act="editCash" data-id="${c.id}"`}><span>${esc(c.note || catName(c.catId) || 'Запись')}${c.note && catName(c.catId) ? `<span class="sub">${esc(catName(c.catId))}</span>` : ''}</span><span class="num">${cashLine(c)}</span></button>` + photoGrid(cashPhotos(c.id))).join('')}
    ${dayAdv.length ? `<div class="item"><span>Аванс<span class="sub">${dayAdv.map(a => esc(empName(a.employeeId))).join(', ')}</span></span><span class="num">− ${money(sum(dayAdv, 'amount'))}</span></div>` : ''}
    ${t.days[d] && t.days[d].salary ? `<div class="item"><span>Зарплата<span class="sub">${t.days[d].pays.map(p => esc(p.e.name)).join(', ')}</span></span><span class="num">− ${money(t.days[d].salary)}</span></div>` : ''}
    ${VIEWER ? (dayCash.length || dayAdv.length ? '' : '<p class="sub">Записей нет</p>') : `<form data-form="cash" class="stack" style="margin-top:10px">
      <div class="grid3">
        <label class="fld"><span>Наличные</span><input name="cash" inputmode="decimal" placeholder="0" autocomplete="off"></label>
        <label class="fld"><span>Добавлено</span><input name="added" inputmode="decimal" placeholder="0" autocomplete="off"></label>
        <label class="fld"><span>Расход</span><input name="expense" inputmode="decimal" placeholder="0" autocomplete="off"></label>
      </div>
      <div class="grid2"><select name="cat" aria-label="Категория">${opts(catOpts(), '')}</select>
        <input name="note" placeholder="Комментарий" autocomplete="off"></div>
      <label class="filebtn photobtn">📷 Фото чека<span id="cashPhotoCount"></span>
        <input type="file" accept="image/*" multiple data-change="cashFormPhotos"></label>
      <button class="primary">Добавить</button>
    </form>`}
    <div class="big"><span class="muted">Остаток на конец дня</span><b class="${balanceAt(d, t) < 0 ? 'neg' : ''}">${money(balanceAt(d, t))}</b></div>
  </section>`;
  return rentBanner() + dayCard + cashMonth(t, m, issues);
}
function cashMonth(t, m, issues) {
  const before = balanceAt(addDays(m + '-01', -1), t);
  let inc = 0, exp = 0, adv = 0, sal = 0;
  t.dates.filter(d => d.startsWith(m)).forEach(d => { const x = t.days[d]; inc += x.cash + x.added; exp += x.expense; adv += x.advance; sal += x.salary; });
  const end = before + inc - exp - adv - sal;
  const mdates = [...new Set([...t.dates, ...Object.keys(issues)])].filter(d => d.startsWith(m)).sort().reverse();

  let summary = `<section class="card"><h2>Итог за ${fmtMonth(m).toLowerCase()}</h2>
    <div class="stats">
      <div class="stat"><small>На начало</small><b>${money(before)}</b></div>
      <div class="stat"><small>Приход</small><b>${money(inc)}</b></div>
      <div class="stat"><small>Расход</small><b>${money(exp)}</b></div>
      <div class="stat"><small>Аванс</small><b>${money(adv)}</b></div>
      ${sal ? `<div class="stat"><small>Зарплата</small><b>${money(sal)}</b></div>` : ''}
    </div>
    <div class="big"><span class="muted">Остаток на конец</span><b class="${end < 0 ? 'neg' : ''}">${money(end)}</b></div></section>`;

  summary += catSummary(m);
  if (!mdates.length) return summary + `<section class="card empty"><p>В этом месяце записей нет.</p></section>`;

  return summary + mdates.map(d => {
    const x = t.days[d];
    const iss = (issues[d] || []).map(i => `<button class="status bad" data-act="goDay" data-date="${d}" data-point="${i.pointId}">
      ❗ ${esc(pointName(i.pointId))}: чек ${i.left > 0 ? 'не разделён на ' + money(i.left) : 'разделён больше на ' + money(-i.left)} — открыть</button>`).join('');
    if (!x) return `<section class="card"><div class="dayhead"><b>${fmtDay(d)}</b></div>${iss}</section>`;
    return `<section class="card">
      <button class="item dayhead" data-act="setDate" data-date="${d}"><b>${fmtDay(d)}</b><span class="muted">остаток <b class="num ${x.balance < 0 ? 'neg' : ''}" style="color:inherit">${money(x.balance)}</b> ›</span></button>
      ${x.entries.map(c => { const np = cashPhotos(c.id).length; return `<button class="item" data-act="setDate" data-date="${c.date}">
          <span>${esc(c.note || 'Запись')}${np ? `<span class="sub">📷 ${np}</span>` : ''}</span><span class="num">${cashLine(c)}</span></button>`; }).join('')}
      ${x.advance ? `<button class="item" data-act="setDate" data-date="${d}"><span>Аванс<span class="sub">${x.advs.map(a => esc(empName(a.employeeId))).join(', ')}</span></span><span class="num">− ${money(x.advance)}</span></button>` : ''}
      ${x.salary ? `<button class="item" data-act="setDate" data-date="${d}"><span>Зарплата<span class="sub">${x.pays.map(p => esc(p.e.name)).join(', ')}</span></span><span class="num">− ${money(x.salary)}</span></button>` : ''}
      ${iss}</section>`;
  }).join('');
}

/* ---------- Отчёт: выручка = «Счёт кассы» ---------- */
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const shortMonth = m => MON_SHORT[+m.slice(5) - 1] + (m.slice(0, 4) !== today().slice(0, 4) ? " '" + m.slice(2, 4) : '');
const SERIES = n => `var(--s${(n % 8) + 1})`; // цвет кафе — по его месту в списке точек, всегда один и тот же
const rev = (pid, from, to) => db.registers.filter(r => r.date >= from && r.date <= to && (!pid || r.pointId === pid)).reduce((a, r) => a + num(r.register), 0);
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
const kfmt = v => v < 0 ? '−' + kfmt(-v) : v >= 1e6 ? (Math.round(v / 1e5) / 10).toLocaleString('ru-RU') + ' млн' : v >= 1e3 ? (Math.round(v / 100) / 10).toLocaleString('ru-RU') + ' т' : String(Math.round(v));

// Графики: SVG без библиотек; подсказка по касанию/наведению
let charts = {}, chartSeq = 0;
// Столбик: скруглён край с данными, у нуля — прямой (down — столбик вниз, для минуса)
function barPath(x, y, w, h, down) {
  const r = Math.min(4, w / 2, h), yb = y + h;
  return down
    ? `M${x} ${y}V${yb - r}Q${x} ${yb} ${x + r} ${yb}H${x + w - r}Q${x + w} ${yb} ${x + w} ${yb - r}V${y}Z`
    : `M${x} ${yb}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${yb}Z`;
}
// Шкала: столбики — от нуля; линии — по диапазону данных, чтобы рост был виден
function yScale(vals, fromZero) {
  const hi0 = Math.max(1, ...vals);
  let lo = fromZero ? Math.min(0, ...vals) : Math.min(...vals);
  if (!fromZero) lo = Math.max(0, lo - ((hi0 - lo) * 0.25 || hi0 * 0.1));
  const step = niceMax((hi0 - lo) / 4 || 1);
  lo = Math.floor(lo / step) * step;
  let hi = Math.ceil(hi0 / step) * step; if (hi <= lo) hi = lo + step;
  return { lo, hi, step };
}
// opt.partialLast — последний месяц ещё не закончился: пунктир и полая точка
function chartSvg(kind, labels, series, tips, opt = {}) {
  const id = 'ch' + (++chartSeq);
  const W = 340, H = 190, L = 40, R = 8, T = 10, B = 24, pw = W - L - R, ph = H - T - B, n = labels.length;
  const sc = yScale(series.flatMap(s => s.values.filter(v => v != null)), kind === 'bar');
  const x = i => kind === 'bar' ? L + pw * (i + 0.5) / n : L + (n === 1 ? pw / 2 : pw * i / (n - 1));
  const y = v => T + ph - ph * (v - sc.lo) / (sc.hi - sc.lo);
  charts[id] = { kind, n, L, pw, W, x, tips };
  let g = '';
  for (let v = sc.lo; v <= sc.hi + 1e-9; v += sc.step) { const yy = y(v); g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" class="cgrid${v === sc.lo && !v ? ' cbase' : ''}"/><text x="${L - 5}" y="${yy + 3.5}" class="cylab">${kfmt(v)}</text>`; }
  const step = Math.ceil(n / 7);
  labels.forEach((l, i) => { if (i % step === 0 || (kind !== 'bar' && i === n - 1)) g += `<text x="${x(i)}" y="${H - 7}" class="cxlab">${esc(l)}</text>`; });
  let marks = '';
  if (kind === 'bar') {
    const bw = Math.min(28, Math.max(2, pw / n - 2));
    const y0 = y(0);
    series[0].values.forEach((v, i) => {
      if (v > 0) { const yy = y(v); marks += `<path d="${barPath(x(i) - bw / 2, yy, bw, y0 - yy)}" fill="${series[0].color}"/>`; }
      else if (v < 0) { const yy = y(v); marks += `<path d="${barPath(x(i) - bw / 2, y0, bw, yy - y0, true)}" fill="${series[0].color}"/>`; }
    });
    if (sc.lo < 0) g += `<line x1="${L}" x2="${W - R}" y1="${y0}" y2="${y0}" class="cgrid cbase"/>`;
  } else {
    const last = opt.partialLast ? n - 1 : n;
    series.forEach(s => {
      let d = '', pen = false;
      s.values.forEach((v, i) => { if (i >= last) return; if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
      marks += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (last < n && n > 1 && s.values[n - 2] != null && s.values[n - 1] != null)
        marks += `<path d="M${x(n - 2)} ${y(s.values[n - 2])}L${x(n - 1)} ${y(s.values[n - 1])}" fill="none" stroke="${s.color}" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round"/>`;
      s.values.forEach((v, i) => { if (v != null) marks += i >= last
        ? `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="var(--card)" stroke="${s.color}" stroke-width="2"/>`
        : `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${s.color}" stroke="var(--card)" stroke-width="2"/>`; });
    });
  }
  return `<div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="График">${g}${marks}
    <line class="ccross" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/></svg><div class="ctip" hidden></div></div>`;
}
function legend(series) {
  return series.length < 2 ? '' : `<div class="clegend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
function chartHover(e) {
  const box = e.target.closest('.chart'); if (!box) return;
  const c = charts[box.dataset.chart]; if (!c) return;
  const svg = box.querySelector('svg'), r = svg.getBoundingClientRect();
  const sx = (e.clientX - r.left) * c.W / r.width;
  let i = c.kind === 'bar' ? Math.floor((sx - c.L) / c.pw * c.n) : Math.round((sx - c.L) / c.pw * (c.n - 1));
  i = Math.max(0, Math.min(c.n - 1, i));
  const ln = svg.querySelector('.ccross'), px = c.x(i);
  ln.setAttribute('x1', px); ln.setAttribute('x2', px); ln.setAttribute('visibility', 'visible');
  const tip = box.querySelector('.ctip'); tip.innerHTML = c.tips[i]; tip.hidden = false;
  const left = px / c.W * r.width;
  tip.style.left = Math.max(0, Math.min(r.width - tip.offsetWidth, left - tip.offsetWidth / 2)) + 'px';
}
document.addEventListener('pointerdown', chartHover);
document.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || e.buttons) chartHover(e); });
document.addEventListener('pointerout', e => {
  const box = e.target.closest && e.target.closest('.chart');
  if (box && e.pointerType === 'mouse' && !box.contains(e.relatedTarget)) { box.querySelector('.ctip').hidden = true; box.querySelector('.ccross').setAttribute('visibility', 'hidden'); }
});

const pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
function deltaHtml(a, b) {
  const p = pct(a, b);
  if (p === null) return '<span class="muted">нет данных для сравнения</span>';
  if (p === 0) return '<span class="muted">без изменений</span>';
  return `<span class="${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲ +' : '▼ −'}${Math.abs(p)}%</span>`;
}

// Сотрудники, которым начисляется зарплата за месяц (как во вкладке «Зарплата»)
function payrollEmps(m) {
  return db.employees.filter(e => db.food.some(f => f.employeeId === e.id && f.date.startsWith(m)) ||
    db.advances.some(a => a.employeeId === e.id && a.date.startsWith(m)) || db.fines.some(x => x.employeeId === e.id && x.date.startsWith(m)) || (e.paid && e.paid[m]) || (!e.archived && workDays(e, m).days > 0));
}
// Прибыль за месяц. В текущем месяце зарплата — пропорционально прошедшим дням.
function profitMonth(m) {
  const from = m + '-01', end = monthEnd(m), inM = x => x.date >= from && x.date <= end;
  const isCur = m === today().slice(0, 7), frac = isCur ? +today().slice(8) / +end.slice(8) : m > today().slice(0, 7) ? 0 : 1;
  const R = rev('', from, end);
  const C = db.registers.filter(inM).reduce((a, r) => a + num(r.check), 0);
  const F = db.food.filter(x => inM(x) && x.employeeId !== BOSS).reduce((a, x) => a + num(x.amount), 0);
  const N = db.fines.filter(inM).reduce((a, x) => a + num(x.amount), 0);
  const S = payrollEmps(m).reduce((a, e) => a + accrued(e, m).amount * frac, 0);
  const cats = catTotals(m), E = cats.reduce((a, x) => a + x[1], 0);
  const P = db.stock.filter(s => s.kind === 'in' && !s.fromCash && inM(s)).reduce((a, s) => a + num(s.amount), 0);
  return { R, C, F, N, S, E, P, cats, isCur, profit: R - C + F + N - S - E - P };
}
// Дни, за которые касса не внесена (с первого дня, когда по точке есть записи)
function missingDays(pid, from, to) {
  const first = db.registers.filter(r => r.pointId === pid).map(r => r.date).sort()[0];
  if (!first) return [];
  const out = [];
  for (let d = from < first ? first : from; d <= to; d = addDays(d, 1)) {
    const r = getReg(d, pid);
    if (!r || (!num(r.register) && !r.closed)) out.push(d);
  }
  return out;
}
function missingBanner() {
  if (VIEWER) return '';
  const yest = addDays(today(), -1), from = addDays(today(), -14);
  const list = [];
  sortedPoints().forEach(p => missingDays(p.id, from, yest).forEach(d => list.push({ d, p })));
  if (!list.length) return '';
  list.sort((a, b) => b.d.localeCompare(a.d));
  return `<section class="card status warn missing"><b>Не внесена касса (${list.length})</b>
    ${list.slice(0, 6).map(x => `<div class="mrow"><span>${x.d === yest ? 'Вчера' : fmtDay(x.d)} · ${esc(x.p.name)}</span>
      <span><button data-act="goDay" data-date="${x.d}" data-point="${x.p.id}">Внести</button><button data-act="markClosed" data-date="${x.d}" data-point="${x.p.id}">Выходной</button></span></div>`).join('')}
    ${list.length > 6 ? `<p class="sub">и ещё ${list.length - 6}</p>` : ''}</section>`;
}

function viewReport() {
  if (!db.points.length) return emptyState();
  charts = {};
  const m = ui.month, pts = sortedPoints(), color = {};
  pts.forEach((p, i) => color[p.id] = SERIES(i));
  const isCur = m === today().slice(0, 7);
  // Текущий месяц сравниваем с теми же днями прошлого месяца
  const endDay = isCur ? +today().slice(8) : +monthEnd(m).slice(8);
  const pm = addMonths(m, -1), pmEnd = Math.min(endDay, +monthEnd(pm).slice(8));
  const from = m + '-01', to = m + '-' + pad(endDay), pFrom = pm + '-01', pTo = pm + '-' + pad(pmEnd);
  const total = rev('', from, monthEnd(m)), prevSame = rev('', pFrom, pTo);
  const daysWith = new Set(db.registers.filter(r => r.date.startsWith(m) && num(r.register)).map(r => r.date)).size;

  // 12 месяцев до выбранного, без пустых в начале
  let months = Array.from({ length: 12 }, (_, i) => addMonths(m, i - 11));
  const firstIdx = months.findIndex(mm => rev('', mm + '-01', monthEnd(mm)) > 0);
  months = firstIdx < 0 ? [m] : months.slice(Math.min(firstIdx, 11));
  const mTot = months.map(mm => rev('', mm + '-01', monthEnd(mm)));
  const partial = months[months.length - 1] === today().slice(0, 7);
  const partNote = mm => partial && mm === months[months.length - 1] ? `<br><span class="muted">месяц ещё идёт (по ${fmtShort(today())})</span>` : '';
  const totalChart = chartSvg('line', months.map(shortMonth), [{ name: 'Всего', color: 'var(--s1)', values: mTot }],
    months.map((mm, i) => `<b>${fmtMonth(mm)}</b><br>Всего: ${money(mTot[i])}${i && !partNote(mm) ? '<br>' + deltaHtml(mTot[i], mTot[i - 1]) + ' к пред. месяцу' : ''}${partNote(mm)}`),
    { partialLast: partial });

  const ptSeries = pts.map(p => ({ name: p.name, color: color[p.id], values: months.map(mm => rev(p.id, mm + '-01', monthEnd(mm))) }));
  const ptChart = chartSvg('line', months.map(shortMonth), ptSeries,
    months.map((mm, i) => `<b>${fmtMonth(mm)}</b>` + ptSeries.map(s => `<br><i class="sw" style="background:${s.color}"></i>${esc(s.name)}: ${money(s.values[i])}`).join('') + partNote(mm)),
    { partialLast: partial });
  const partialHint = partial ? '<p class="sub" style="margin-top:6px">Пунктир — текущий месяц, он ещё не закончился.</p>' : '';

  // По дням выбранного месяца
  const dim = +monthEnd(m).slice(8), days = Array.from({ length: dim }, (_, i) => m + '-' + pad(i + 1));
  const dTot = days.map(d => rev('', d, d));
  const dayChart = chartSvg('bar', days.map(d => String(+d.slice(8))), [{ name: 'Всего', color: 'var(--s1)', values: dTot }],
    days.map((d, i) => `<b>${fmtDay(d)}</b><br>Всего: ${money(dTot[i])}` + (dTot[i] ? pts.map(p => { const v = rev(p.id, d, d); return v ? `<br><i class="sw" style="background:${color[p.id]}"></i>${esc(p.name)}: ${money(v)}` : ''; }).join('') : '<br><span class="muted">касса не внесена</span>')));

  // Таблица по кафе
  const rows = pts.map(p => {
    const cur = rev(p.id, from, monthEnd(m)), prev = rev(p.id, pFrom, pTo);
    const dvals = days.map(d => rev(p.id, d, d)), n = dvals.filter(v => v > 0).length, best = Math.max(0, ...dvals);
    return { p, cur, prev, avg: n ? cur / n : 0, best, bestDay: best ? days[dvals.indexOf(best)] : '' };
  });

  // Пропущенные дни в выбранном месяце (до вчера)
  const missTo = isCur ? addDays(today(), -1) : monthEnd(m);
  const miss = pts.map(p => ({ p, n: missingDays(p.id, from, missTo).length })).filter(x => x.n);

  // Прибыль
  const pr = profitMonth(m);
  const pRows = [
    ['Выручка (счёт кассы)', pr.R, ''],
    ['Питание по чеку', -pr.C, 'еда сотрудников и гостей — денег не пришло'],
    ['Удержано за питание', pr.F, 'вычтено из зарплаты'],
    ['Удержано штрафов', pr.N, 'вычтено из зарплаты'],
    ['Зарплата (начислено)', -pr.S, pr.isCur ? 'за прошедшие дни месяца' : ''],
    ...pr.cats.map(([k, v]) => ['Расход: ' + k, -v, '']),
    ...(pr.P ? [['Продукты не из налички', -pr.P, 'приход на склад']] : []),
  ].filter(r => r[1]);
  const mProfit = months.map(mm => Math.round(profitMonth(mm).profit));
  const profitChart = chartSvg('bar', months.map(shortMonth), [{ name: 'Прибыль', color: 'var(--s3)', values: mProfit }],
    months.map((mm, i) => `<b>${fmtMonth(mm)}</b><br>Прибыль: ${money(mProfit[i])}${partNote(mm)}`));

  return `${miss.length ? `<p class="status warn">Не внесена касса: ${miss.map(x => esc(x.p.name) + ' — ' + x.n + ' дн.').join(', ')}. Выручка и прибыль будут ниже реальных.</p>` : ''}
    <section class="card"><h2>Выручка за ${fmtMonth(m).toLowerCase()}</h2>
      <div class="hero"><b>${money(total)}</b>${deltaHtml(rev('', from, to), prevSame)}</div>
      <p class="sub">${prevSame ? `сравнение с 1–${pmEnd} ${MONTHS_GEN[+pm.slice(5) - 1]}: ${money(prevSame)}` : ''}${daysWith ? ` · в среднем ${money(total / daysWith)} за день (${daysWith} дн. с данными)` : ''}</p>
    </section>
    <section class="card"><h2>Прибыль за ${fmtMonth(m).toLowerCase()}</h2>
      <div class="hero"><b class="${pr.profit < 0 ? 'neg' : ''}">${money(pr.profit)}</b>${pr.R ? `<span class="muted">${Math.round(pr.profit / pr.R * 100)}% от выручки</span>` : ''}</div>
      <details class="pdetail"><summary>Как посчитано</summary>
        ${pRows.map(([k, v, note]) => `<div class="item"><span>${esc(k)}${note ? `<span class="sub">${esc(note)}</span>` : ''}</span><span class="num">${v > 0 ? '+ ' : '− '}${money(Math.abs(v))}</span></div>`).join('')}
        <div class="item"><span><b>Прибыль</b></span><span class="num"><b>${money(pr.profit)}</b></span></div>
      </details>
      ${pr.isCur ? '<p class="sub" style="margin-top:6px">Месяц ещё идёт: аренда и другие расходы могли быть ещё не внесены.</p>' : ''}
    </section>
    <section class="card"><h2>По кафе</h2>
      <div class="ptable">${rows.map(r => `<div class="item"><span><i class="sw" style="background:${color[r.p.id]}"></i>${esc(r.p.name)}
        <span class="sub">ср. ${money(r.avg)}/день${r.best ? ' · лучший ' + fmtShort(r.bestDay) + ': ' + money(r.best) : ''}</span></span>
        <span class="num rt">${money(r.cur)}<small>${deltaHtml(rev(r.p.id, from, to), r.prev)}</small></span></div>`).join('')}</div>
    </section>
    <section class="card"><h2>Рост по месяцам — все кафе</h2>${totalChart}${partialHint}</section>
    <section class="card"><h2>Прибыль по месяцам</h2>${profitChart}${partial ? '<p class="sub" style="margin-top:6px">Последний столбик — текущий месяц, он ещё не закончился.</p>' : ''}</section>
    <section class="card"><h2>Рост по месяцам — каждое кафе</h2>${legend(ptSeries)}${ptChart}${partialHint}</section>
    <section class="card"><h2>По дням · ${fmtMonth(m).toLowerCase()}</h2>${dayChart}
      <p class="sub" style="margin-top:6px">Нажмите на график, чтобы увидеть сумму. Выручка = «Счёт кассы» на вкладке «День».</p></section>`;
}

/* ---------- Склад ---------- */
// stock: { date, kind, productId, qty, pointId?, amount?, fromCash?, cashId?, createdAt }
//   in — приход на склад; out — выдача на точку; wcount — пересчёт склада (qty = факт);
//   pcount — пересчёт на точке (qty = сколько осталось на точке)
const prod = id => db.products.find(p => p.id === id);
const prodName = id => prod(id)?.name || '(продукт удалён)';
const unitOf = id => prod(id)?.unit || '';
const qtyStr = (n, pid) => (Math.round(num(n) * 1000) / 1000).toLocaleString('ru-RU') + (pid ? ' ' + unitOf(pid) : '');
const sortedProducts = all => db.products.filter(p => all || !p.archived).sort(byName);
const stockSort = (a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0);

// Остаток на складе на конец даты и списания по пересчётам
function whLedger(pid, upTo) {
  let rest = 0; const off = [];
  db.stock.filter(s => s.productId === pid && s.kind !== 'pcount' && (!upTo || s.date <= upTo)).sort(stockSort).forEach(s => {
    if (s.kind === 'in') rest += num(s.qty);
    else if (s.kind === 'out') rest -= num(s.qty);
    else if (s.kind === 'wcount') { off.push({ date: s.date, qty: rest - num(s.qty) }); rest = num(s.qty); }
  });
  return { rest, off };
}
// Остаток на точке по последнему пересчёту (нет пересчёта — считаем, что всё израсходовано)
function pointStockAt(point, pid, date) {
  let best = null;
  db.stock.forEach(s => { if (s.kind === 'pcount' && s.pointId === point && s.productId === pid && s.date <= date && (!best || stockSort(best, s) < 0)) best = s; });
  return best ? num(best.qty) : 0;
}
// Расход точки за период: выдано + остаток на начало − остаток на конец
function pointUse(point, pid, from, to) {
  const issued = db.stock.filter(s => s.kind === 'out' && s.pointId === point && s.productId === pid && s.date >= from && s.date <= to).reduce((a, s) => a + num(s.qty), 0);
  const start = pointStockAt(point, pid, addDays(from, -1)), end = pointStockAt(point, pid, to);
  return { issued, use: issued + start - end, start, end };
}
function monthEnd(m) { const [y, mm] = m.split('-').map(Number); return m + '-' + pad(new Date(y, mm, 0).getDate()); }
// Сводка по продукту за месяц
function stockMonth(pid, m) {
  const from = m + '-01', to = monthEnd(m), inM = s => s.productId === pid && s.date >= from && s.date <= to;
  const income = db.stock.filter(s => inM(s) && s.kind === 'in').reduce((a, s) => a + num(s.qty), 0);
  const spent = db.stock.filter(s => inM(s) && s.kind === 'in').reduce((a, s) => a + num(s.amount), 0);
  const pts = sortedPoints().map(p => Object.assign({ p }, pointUse(p.id, pid, from, to)));
  const off = whLedger(pid, to).off.filter(o => o.date >= from).reduce((a, o) => a + o.qty, 0);
  return { income, spent, pts, off, start: whLedger(pid, addDays(from, -1)).rest, end: whLedger(pid, to).rest,
    total: pts.reduce((a, x) => a + x.use, 0) + off };
}

function stockLine(s) {
  const n = prodName(s.productId), q = qtyStr(s.qty, s.productId);
  if (s.kind === 'in') return ['Приход · ' + n, q + (num(s.amount) ? ' · ' + money(s.amount) + (s.fromCash ? ' (из налички)' : '') : '')];
  if (s.kind === 'out') return ['Выдано → ' + pointName(s.pointId) + ' · ' + n, q];
  if (s.kind === 'wcount') return ['Пересчёт склада · ' + n, 'факт ' + q];
  return ['Пересчёт ' + pointName(s.pointId) + ' · ' + n, 'осталось ' + q];
}

function viewStock() {
  const d = ui.date, m = d.slice(0, 7), prods = sortedProducts();
  if (!prods.length) return VIEWER ? `<section class="card empty"><p>Продукты ещё не добавлены.</p></section>`
    : `<section class="card empty"><h3>Склад</h3><p>Добавьте продукты, которые храните на складе: название и единицу (кг, шт, л).</p>
       <button class="primary" data-act="addProduct">+ Добавить продукт</button></section>`;

  const rests = prods.map(p => ({ p, rest: whLedger(p.id, d).rest }));
  const restCard = `<section class="card"><h2>Остаток на складе <span class="muted">на ${fmtShort(d)}</span></h2>
    ${rests.map(({ p, rest }) => { const low = rest < 0 ? 'bad' : num(p.minQty) && rest <= num(p.minQty) ? 'warn' : '';
      return `<div class="item"><span>${esc(p.name)}${low ? ` <span class="badge ${low}">${rest < 0 ? 'меньше нуля' : 'мало'}</span>` : ''}</span><span class="num">${qtyStr(rest, p.id)}</span></div>`; }).join('')}
  </section>`;

  const pOpts = opts(prods.map(p => ({ v: p.id, t: p.name + ' (' + p.unit + ')' })), ui.stockProd);
  const forms = VIEWER ? '' : `<section class="card"><h2>Записать</h2>
    <form data-form="stockOut" class="stack">
      <span class="fld"><span>Выдать на точку</span></span>
      <div class="grid2"><select name="point" aria-label="Точка">${opts(sortedPoints().map(p => ({ v: p.id, t: p.name })), ui.stockPoint)}</select>
        <select name="prod" aria-label="Продукт">${pOpts}</select></div>
      <div class="quick" style="margin-top:0"><input name="qty" inputmode="decimal" placeholder="Сколько" autocomplete="off" aria-label="Сколько">
        <button class="primary" style="flex:0 0 auto;font-size:16px;padding:0 16px">Выдать</button></div>
    </form>
    <form data-form="stockIn" class="stack" style="margin-top:14px">
      <span class="fld"><span>Приход на склад</span></span>
      <select name="prod" aria-label="Продукт">${pOpts}</select>
      <div class="grid2"><input name="qty" inputmode="decimal" placeholder="Сколько" autocomplete="off" aria-label="Сколько">
        <input name="amount" inputmode="decimal" placeholder="Сумма (необяз.)" autocomplete="off" aria-label="Сумма"></div>
      <label class="chk"><input type="checkbox" name="fromCash" checked><span>Оплачено из налички (уйдёт в расход «Продукты»)</span></label>
      <button class="primary">Приход</button>
    </form>
    <div class="grid2" style="margin-top:14px"><button data-act="wcount">Пересчёт склада</button><button data-act="pcount">Пересчёт на точке</button></div>
  </section>`;

  const moves = db.stock.filter(s => s.date === d).sort(stockSort);
  const movesCard = `<section class="card"><h2>Движения за день <span class="badge">${moves.length}</span></h2>
    ${moves.length ? moves.map(s => { const [a, b] = stockLine(s); return `<button class="item" ${VIEWER ? '' : `data-act="editStock" data-id="${s.id}"`}><span>${esc(a)}</span><span class="num">${esc(b)}</span></button>`; }).join('') : '<p class="sub">Нет записей</p>'}
  </section>`;

  const month = prods.map(p => ({ p, s: stockMonth(p.id, m) })).filter(x => x.s.income || x.s.total || x.s.pts.some(t => t.issued || t.end));
  const monthCard = `<section class="card"><h2>Расход за ${fmtMonth(m).toLowerCase()}</h2>
    ${month.length ? month.map(({ p, s }) => `<div class="item stockm"><span><b>${esc(p.name)}</b><span class="sub">
        ${s.pts.filter(t => t.issued || t.use || t.end).map(t => `<span class="${t.use < 0 ? 'neg' : ''}">${esc(t.p.name)}: ${qtyStr(t.use)}${t.end ? ' (ост. ' + qtyStr(t.end) + ')' : ''}</span>`).join(' · ')}
        ${s.off ? ` · <span class="${s.off < 0 ? 'neg' : ''}">списано ${qtyStr(s.off)}</span>` : ''}
        ${s.income ? `<br>пришло ${qtyStr(s.income)}${s.spent ? ' на ' + money(s.spent) : ''}` : ''}</span></span>
      <span class="num">${qtyStr(s.total, p.id)}</span></div>`).join('')
      : '<p class="sub">В этом месяце расхода нет</p>'}
    <p class="sub" style="margin-top:8px">Расход точки = выдано + остаток на точке на начало − остаток на конец (по пересчётам). Без пересчёта всё выданное считается израсходованным.</p>
  </section>`;

  const prodCard = VIEWER ? '' : `<details class="card"><summary><span><b>Продукты</b><span class="sub">Название, единица, «мало» — порог для предупреждения</span></span><span class="badge">${db.products.length}</span></summary>
    ${sortedProducts(true).map(p => `<button class="item" data-act="editProduct" data-id="${p.id}"><span>${esc(p.name)}${p.archived ? ' <span class="badge warn">скрыт</span>' : ''}</span><span class="sub">${esc(p.unit)}${num(p.minQty) ? ' · мало ≤ ' + qtyStr(p.minQty) : ''}</span></button>`).join('')}
    <button class="primary wide" style="margin-top:10px" data-act="addProduct">+ Добавить продукт</button></details>`;

  return restCard + forms + movesCard + monthCard + prodCard;
}

function productSheet(p) {
  const isNew = !p; p = p || { unit: 'кг' };
  const used = !isNew && db.stock.some(s => s.productId === p.id);
  openSheet({
    title: isNew ? 'Новый продукт' : 'Продукт',
    fields: [
      { name: 'name', label: 'Название', value: p.name, placeholder: 'Мясо' },
      { name: 'unit', label: 'Единица', value: p.unit, placeholder: 'кг, шт, л' },
      { name: 'minQty', label: 'Предупреждать, когда на складе осталось не больше (необязательно)', type: 'number', value: p.minQty },
      ...(isNew ? [] : [{ name: 'archived', label: 'Скрыть (больше не используется)', type: 'check', value: p.archived }]),
      ...(used ? [{ type: 'note', label: 'По продукту есть записи, поэтому его нельзя удалить — можно скрыть.' }] : []),
    ],
    onSave: v => {
      if (!v.name) { toast('Введите название'); return false; }
      Object.assign(p, { name: v.name, unit: v.unit || 'шт', minQty: num(v.minQty), archived: !!v.archived });
      if (isNew) { p.id = uid(); db.products.push(p); }
      stamp(p); toast('Сохранено');
    },
    onDelete: isNew || used ? null : () => removeRec('products', p),
    deleteConfirm: 'Удалить продукт?',
  });
}

// Приход, оплаченный из налички, создаёт связанную запись расхода в «Наличке»
/* ---------- Аренда точек ---------- */
function catByName(name) {
  let c = db.cats.find(x => x.name.trim().toLowerCase() === name.toLowerCase());
  if (!c) { c = stamp({ id: uid(), name }); db.cats.push(c); }
  return c.id;
}
// Оплачена ли аренда точки за месяц: запись от кнопки «Внести» или ручной расход «Аренда» с названием точки
function rentPaid(p, m) {
  const rc = db.cats.find(x => x.name.trim().toLowerCase() === 'аренда');
  return db.cash.some(c => c.date.startsWith(m) && (c.rentFor === m && c.pointId === p.id ||
    rc && c.catId === rc.id && num(c.expense) && (c.pointId === p.id || (c.note || '').toLowerCase().includes(p.name.toLowerCase()))));
}
function rentDue() {
  const t = today(), cur = t.slice(0, 7), out = [];
  sortedPoints().filter(p => num(p.rent)).forEach(p => {
    for (let m = p.rentSince || cur; m <= cur; m = addMonths(m, 1)) {
      if (m === cur && +t.slice(8) < (p.rentDay || 1)) continue;
      if (!rentPaid(p, m)) out.push({ p, m });
    }
  });
  return out;
}
function rentBanner() {
  if (VIEWER) return '';
  const due = rentDue();
  if (!due.length) return '';
  return `<section class="card status warn missing"><b>Аренда не внесена</b>
    ${due.map(x => `<div class="mrow"><span>${esc(x.p.name)} · ${fmtMonth(x.m).toLowerCase()}<span class="sub">${money(x.p.rent)}</span></span>
      <span><button data-act="payRent" data-point="${x.p.id}" data-month="${x.m}">Внести</button></span></div>`).join('')}</section>`;
}

function productsCat() {
  let c = db.cats.find(x => x.name.trim().toLowerCase() === 'продукты');
  if (!c) { c = stamp({ id: uid(), name: 'Продукты' }); db.cats.push(c); }
  return c.id;
}
function syncStockCash(s) {
  let c = s.cashId && db.cash.find(x => x.id === s.cashId);
  const need = s.kind === 'in' && s.fromCash && num(s.amount) > 0;
  if (!need) { if (c) removeRec('cash', c); s.cashId = ''; return; }
  const note = 'Склад: ' + prodName(s.productId) + ' ' + qtyStr(s.qty, s.productId);
  if (!c) { c = { id: uid(), pointId: '', cash: 0, added: 0, stockId: s.id }; db.cash.push(c); s.cashId = c.id; }
  Object.assign(c, { date: s.date, expense: num(s.amount), note, catId: c.catId || productsCat() }); stamp(c);
}

function stockSheet(s) {
  const prods = sortedProducts(true).map(p => ({ v: p.id, t: p.name + ' (' + p.unit + ')' }));
  const pts = sortedPoints().map(p => ({ v: p.id, t: p.name }));
  const titles = { in: 'Приход на склад', out: 'Выдача на точку', wcount: 'Пересчёт склада', pcount: 'Пересчёт на точке' };
  openSheet({
    title: titles[s.kind],
    fields: [
      ...(s.kind === 'out' || s.kind === 'pcount' ? [{ name: 'pointId', label: 'Точка', type: 'select', options: pts, value: s.pointId }] : []),
      { name: 'productId', label: 'Продукт', type: 'select', options: prods, value: s.productId },
      { name: 'qty', label: s.kind === 'wcount' ? 'Фактически на складе' : s.kind === 'pcount' ? 'Осталось на точке' : 'Количество', type: 'number', value: s.qty },
      ...(s.kind === 'in' ? [
        { name: 'amount', label: 'Сумма', type: 'number', value: s.amount },
        { name: 'fromCash', label: 'Оплачено из налички', type: 'check', value: s.fromCash },
      ] : []),
      { name: 'date', label: 'Дата', type: 'date', value: s.date },
    ],
    onSave: v => {
      if (num(v.qty) < 0 || (s.kind !== 'wcount' && s.kind !== 'pcount' && num(v.qty) <= 0)) { toast('Введите количество'); return false; }
      Object.assign(s, { productId: v.productId, qty: num(v.qty), date: v.date || s.date });
      if (v.pointId !== undefined) s.pointId = v.pointId;
      if (s.kind === 'in') Object.assign(s, { amount: num(v.amount), fromCash: !!v.fromCash });
      stamp(s); syncStockCash(s);
    },
    onDelete: () => { const c = s.cashId && db.cash.find(x => x.id === s.cashId); if (c) removeRec('cash', c); removeRec('stock', s); },
  });
}

// Пересчёт сразу по всем продуктам: склад (предзаполнен остатком) или точка
function countSheet(kind) {
  const prods = sortedProducts(), d = ui.date;
  const fields = [];
  if (kind === 'pcount') fields.push({ name: 'pointId', label: 'Точка', type: 'select', options: sortedPoints().map(p => ({ v: p.id, t: p.name })), value: ui.stockPoint });
  fields.push({ type: 'note', label: kind === 'wcount'
    ? 'Введите, сколько фактически лежит на складе. Разница с учётом запишется как списание.'
    : 'Введите, сколько осталось на точке. Заполните только то, что пересчитали.' });
  prods.forEach(p => fields.push({ name: 'q_' + p.id, label: p.name + ' (' + p.unit + ')', type: 'number',
    value: kind === 'wcount' ? Math.round(whLedger(p.id, d).rest * 1000) / 1000 : '' }));
  openSheet({
    title: (kind === 'wcount' ? 'Пересчёт склада · ' : 'Пересчёт на точке · ') + fmtShort(d),
    fields,
    saveLabel: 'Сохранить пересчёт',
    onSave: v => {
      let n = 0;
      prods.forEach(p => {
        const raw = v['q_' + p.id]; if (raw === '' || raw == null) return;
        const q = num(raw);
        if (kind === 'wcount' && Math.abs(q - whLedger(p.id, d).rest) < 0.0005) return;
        db.stock.push(stamp({ id: uid(), createdAt: Date.now(), date: d, kind, productId: p.id, qty: q, pointId: kind === 'pcount' ? v.pointId : '' }));
        n++;
      });
      if (kind === 'pcount') ui.stockPoint = v.pointId;
      toast(n ? 'Записано: ' + n : 'Изменений нет');
    },
  });
}

/* ---------- Зарплата ---------- */
function viewPay() {
  if (!db.points.length) return emptyState();
  const m = ui.month, pf = ui.payPoint;
  const inM = x => x.date.startsWith(m);
  const foodM = db.food.filter(inM), advM = db.advances.filter(inM), fineM = db.fines.filter(inM);
  const hasRecs = e => foodM.some(f => f.employeeId === e.id) || advM.some(a => a.employeeId === e.id) || fineM.some(x => x.employeeId === e.id) || (e.paid && e.paid[m]);
  const emps = db.employees.filter(e => (pf === 'all' || e.pointId === pf) &&
      (hasRecs(e) || (!e.archived && workDays(e, m).days > 0)))
    .sort((a, b) => pointName(a.pointId).localeCompare(pointName(b.pointId), 'ru') || byName(a, b));

  let tS = 0, tF = 0, tA = 0, tP = 0, tN = 0;
  let lastPoint = null;
  const cards = emps.map(e => {
    const fl = foodM.filter(f => f.employeeId === e.id), al = advM.filter(a => a.employeeId === e.id), nl = fineM.filter(x => x.employeeId === e.id);
    const ac = accrued(e, m), s = Math.round(ac.amount), f = sum(fl, 'amount'), a = sum(al, 'amount'), fn = sum(nl, 'amount'), pay = s - f - a - fn;
    const paid = e.paid && e.paid[m];
    tS += s; tF += f; tA += a; tN += fn; if (paid) tP += num(paid.amount);
    const hist = [...fl.map(x => ({ d: x.date, t: 'Питание', v: x.amount })), ...al.map(x => ({ d: x.date, t: 'Аванс', v: x.amount })), ...nl.map(x => ({ d: x.date, t: 'Штраф' + (x.note ? ': ' + x.note : ''), v: x.amount }))]
      .sort((p, q) => p.d.localeCompare(q.d));
    const head = pf === 'all' && lastPoint !== e.pointId ? `<div class="group">${esc(pointName(e.pointId))}</div>` : '';
    lastPoint = e.pointId;
    return head + `<details class="card"><summary>
        <span><b>${esc(e.name)}</b>${e.archived ? ' <span class="badge warn">уволен</span>' : ''}<span class="sub">${esc(e.position || '')}</span></span>
        <span class="topay">${paid ? `<small class="paidlbl">✓ выдано</small><b>${money(paid.amount)}</b>` : `<small>к выдаче</small><b class="${pay < 0 ? 'neg' : ''}">${money(pay)}</b>`}</span></summary>
      <div class="kv">
        <div class="stat"><small>Зарплата</small><b>${money(s)}</b></div>
        <div class="stat"><small>Питание</small><b>${money(f)}</b></div>
        <div class="stat"><small>Аванс</small><b>${money(a)}</b></div>
        ${fn ? `<div class="stat"><small>Штраф</small><b>${money(fn)}</b></div>` : ""}
      </div>
      ${ac.days < ac.dim ? `<p class="sub" style="margin-top:6px">Отработано ${ac.days} из ${ac.dim} дн. · оклад ${money(ac.full)}</p>` : ''}
      ${paid ? `<p class="status ok">Выдано ${money(paid.amount)} · ${fmtShort(paid.date)}${paid.fromCash ? ' · из налички' : ''}${Math.round(num(paid.amount)) !== pay ? ` · по расчёту ${money(pay)}` : ''}</p>` : ''}
      ${VIEWER ? '' : `<button class="wide ${paid ? '' : 'primary'}" style="margin-top:10px" data-act="paySheet" data-id="${e.id}">${paid ? 'Изменить выдачу' : 'Отметить выдачу'}</button>`}
      <div class="hist">${hist.length ? hist.map(h => `<div><span>${fmtShort(h.d)} · ${h.t}</span><span class="num">${money(h.v)}</span></div>`).join('') : '<div><span class="muted">Записей за месяц нет</span></div>'}</div>
    </details>`;
  }).join('');

  const boss = foodM.filter(f => f.employeeId === BOSS && (pf === 'all' || f.pointId === pf));
  const bossByPoint = {};
  boss.forEach(f => bossByPoint[f.pointId] = (bossByPoint[f.pointId] || 0) + num(f.amount));
  const bossCard = boss.length ? `<section class="card"><h2>${BOSS_NAME} <span class="num">${money(sum(boss, 'amount'))}</span></h2>
    ${Object.entries(bossByPoint).map(([p, v]) => `<div class="item"><span>${esc(pointName(p))}</span><span class="num">${money(v)}</span></div>`).join('')}
    <p class="sub" style="margin-top:6px">В зарплату не входит</p></section>` : '';

  return `<section class="card"><h2>Итого за ${fmtMonth(m).toLowerCase()}</h2>
    <div class="stats">
      <div class="stat"><small>Зарплаты</small><b>${money(tS)}</b></div>
      <div class="stat"><small>Питание</small><b>${money(tF)}</b></div>
      <div class="stat"><small>Аванс</small><b>${money(tA)}</b></div>
      ${tN ? `<div class="stat"><small>Штрафы</small><b>${money(tN)}</b></div>` : ""}
      <div class="stat"><small>Всего к выдаче</small><b>${money(tS - tF - tA - tN)}</b></div>
      <div class="stat"><small>Уже выдано</small><b>${money(tP)}</b></div>
      <div class="stat"><small>Выдано сотрудникам</small><b>${emps.filter(e => e.paid && e.paid[m]).length} из ${emps.length}</b></div>
    </div>
    <button class="wide" style="margin-top:10px" data-act="exportXlsx" data-month="${m}">📊 Скачать Excel за ${fmtMonth(m).toLowerCase()}</button></section>` +
    (cards || `<section class="card empty"><p>Нет сотрудников. Добавьте их во вкладке «Ещё».</p></section>`) + bossCard;
}

/* ---------- Настройки ---------- */
function viewMore() {
  const pts = sortedPoints();
  const emps = pts.map(p => {
    const list = pointEmps(p.id, true);
    return `<div class="group">${esc(p.name)}</div>` + (list.length ? list.map(e => `<button class="item" data-act="editEmp" data-id="${e.id}">
      <span>${esc(e.name)}${e.archived ? ' <span class="badge warn">уволен</span>' : ''}<span class="sub">${esc(e.position || '—')}</span></span>
      <span class="num">${money(e.salary)}</span></button>`).join('') : '<p class="sub">Нет сотрудников</p>');
  }).join('');
  const lb = db.lastBackup ? new Date(db.lastBackup).toLocaleDateString('ru-RU') : 'ещё не делали';

  if (VIEWER) return `
  <section class="card"><h2>Вход</h2>
    <p>Вы вошли как <b>${esc(syncState.user || '')}</b></p>
    <p class="sub" style="margin:6px 0 10px">Режим просмотра: данные обновляются сами, когда бухгалтер их вносит.</p>
    <button class="wide" data-act="logout">Выйти</button>
  </section>
  ${xlsCard()}
  <section class="card"><h2>Точки и сотрудники</h2>
    ${pts.map(p => `<div class="group">${esc(p.name)}</div>` + (pointEmps(p.id).map(e => `<div class="item"><span>${esc(e.name)}<span class="sub">${esc(e.position || '—')}</span></span><span class="num">${money(e.salary)}</span></div>`).join('') || '<p class="sub">Нет сотрудников</p>')).join('') || '<p class="sub">Пока нет точек</p>'}
  </section>`;

  return `
  ${cloudCard()}
  <section class="card"><h2>Точки (кафе)</h2>
    ${pts.map(p => `<button class="item" data-act="editPoint" data-id="${p.id}"><span>${esc(p.name)}</span><span class="sub">${pointEmps(p.id).length} сотр.</span></button>`).join('') || '<p class="sub">Пока нет точек</p>'}
    <button class="primary wide" style="margin-top:10px" data-act="addPoint">+ Добавить точку</button>
  </section>

  <section class="card"><h2>Сотрудники</h2>
    ${pts.length ? emps : '<p class="sub">Сначала добавьте точку</p>'}
    ${pts.length ? '<button class="primary wide" style="margin-top:10px" data-act="addEmp">+ Добавить сотрудника</button>' : ''}
  </section>

  ${catsCard()}
  ${xlsCard()}
  <section class="card"><h2>Резервная копия</h2>
    <p class="sub">${syncState.user ? 'Данные хранятся в облаке, но копия на всякий случай не помешает.' : 'Данные хранятся только на этом телефоне. Делайте копию раз в неделю и отправляйте её себе, например в Telegram или на Диск.'}</p>
    <p class="sub" style="margin:6px 0 10px">Последняя копия: <b>${lb}</b></p>
    <div class="stack">
      <button class="primary" data-act="export">Сохранить копию (без фото)</button>
      <button data-act="exportPhotos">Сохранить копию с фото</button>
      <label class="filebtn" style="min-height:44px;border-radius:10px;background:var(--line)">Восстановить из копии
        <input type="file" accept=".json,application/json" data-change="importBackup"></label>
    </div>
    <p class="sub" style="margin-top:8px">Копия без фото маленькая — её удобно делать каждую неделю. Копию с фото делайте раз в месяц.</p>
  </section>

  ${trashCard()}

  <section class="card"><h2>Перенос из старого приложения</h2>
    <p class="sub" style="margin-bottom:10px">Выберите сразу все файлы старого приложения: messages.json, employees.json, advance.json, daily_cash.json, cash_book.json.
    Загружайте один раз, иначе записи повторятся.</p>
    <label class="filebtn" style="min-height:44px;border-radius:10px;background:var(--line)">Выбрать файлы
      <input type="file" multiple accept=".json,application/json" data-change="importOld"></label>
  </section>

  <section class="card"><h2>Опасная зона</h2>
    <button class="danger wide" data-act="wipe">Удалить все данные</button>
  </section>`;
}

/* ---------- Категории расходов ---------- */
// Расходы налички за месяц по категориям (+ авансы и зарплата отдельными строками)
function catTotals(m) {
  const by = {};
  db.cash.filter(c => c.date.startsWith(m) && num(c.expense)).forEach(c => { const k = catName(c.catId) || 'Без категории'; by[k] = (by[k] || 0) + num(c.expense); });
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
function catSummary(m) {
  const list = catTotals(m);
  if (!list.length) return '';
  const total = list.reduce((a, x) => a + x[1], 0);
  return `<section class="card"><h2>Расходы по категориям</h2>
    ${list.map(([k, v]) => `<div class="item"><span>${esc(k)}<span class="sub">${Math.round(v / total * 100)}%</span></span><span class="num">${money(v)}</span></div>`).join('')}
    <div class="total">Всего расходов: <b>${money(total)}</b></div></section>`;
}
const catName = id => (id && db.cats.find(c => c.id === id)?.name) || '';
const catOpts = cur => [{ v: '', t: 'Без категории' }, ...db.cats.filter(c => !c.archived || c.id === cur).sort(byName).map(c => ({ v: c.id, t: c.name }))];
function catsCard() {
  const list = [...db.cats].sort(byName);
  return `<section class="card"><h2>Категории расходов</h2>
    ${list.map(c => `<button class="item" data-act="editCat" data-id="${c.id}"><span>${esc(c.name)}${c.archived ? ' <span class="badge warn">скрыта</span>' : ''}</span><span class="sub">${db.cash.filter(x => x.catId === c.id).length} зап.</span></button>`).join('')
      || '<p class="sub">Например: Аренда, Продукты, Хозтовары, Ремонт</p>'}
    <button class="primary wide" style="margin-top:10px" data-act="addCat">+ Добавить категорию</button></section>`;
}
function catSheet(c) {
  const isNew = !c; c = c || {};
  const used = !isNew && db.cash.some(x => x.catId === c.id);
  openSheet({
    title: isNew ? 'Новая категория' : 'Категория',
    fields: [
      { name: 'name', label: 'Название', value: c.name, placeholder: 'Аренда' },
      ...(isNew ? [] : [{ name: 'archived', label: 'Скрыть из списка (старые записи останутся)', type: 'check', value: c.archived }]),
      ...(used ? [{ type: 'note', label: 'В категории есть записи, поэтому её нельзя удалить — можно скрыть.' }] : []),
    ],
    onSave: v => {
      if (!v.name) { toast('Введите название'); return false; }
      Object.assign(c, { name: v.name, archived: !!v.archived });
      if (isNew) { c.id = uid(); db.cats.push(c); }
      stamp(c); toast('Сохранено');
    },
    onDelete: isNew || used ? null : () => removeRec('cats', c),
    deleteConfirm: 'Удалить категорию?',
  });
}

function xlsCard() {
  return `<section class="card"><h2>Выгрузка в Excel</h2>
    <p class="sub" style="margin-bottom:10px">Файл за месяц: касса по точкам с итогами, питание, авансы, наличка, зарплата.</p>
    <div class="quick" style="margin-top:0"><input type="month" id="xlsMonth" value="${ui.month}" aria-label="Месяц">
    <button class="primary" style="flex:0 0 auto;font-size:16px;padding:0 16px" data-act="exportXlsx">Скачать</button></div></section>`;
}
// Корзина: всё удалённое за последние 30 дней
function trashLabel(t) {
  const r = t.rec || {}, when = r.date ? ' · ' + fmtShort(r.date) : '';
  switch (t.col) {
    case 'food': return ['Питание · ' + empName(r.employeeId), pointName(r.pointId) + when, money(r.amount)];
    case 'advances': return ['Аванс · ' + empName(r.employeeId), pointName(r.pointId) + when, money(r.amount)];
    case 'fines': return ['Штраф · ' + empName(r.employeeId), (r.note ? r.note + ' · ' : '') + pointName(r.pointId) + when, money(r.amount)];
    case 'cash': return ['Наличка · ' + (r.note || 'запись'), when.slice(3), cashLine(r)];
    case 'photos': return ['Фото', (r.cashId ? 'чек налички' : pointName(r.pointId)) + when, ''];
    case 'registers': return ['Касса · ' + pointName(r.pointId), when.slice(3), money(num(r.register)) + ' / ' + money(num(r.check))];
    case 'employees': return ['Сотрудник · ' + (r.name || ''), r.position || '', money(r.salary)];
    case 'points': return ['Точка · ' + (r.name || ''), '', ''];
    case 'products': return ['Продукт · ' + (r.name || ''), r.unit || '', ''];
    case 'cats': return ['Категория · ' + (r.name || ''), '', ''];
    case 'stock': { const [a, b] = stockLine(r); return [a, when.slice(3), b]; }
    default: return [t.col, '', ''];
  }
}
function trashList() {
  const old = Date.now() - MONTH_MS;
  return db.deleted.filter(t => t.rec && t.updatedAt > old && !db[t.col].some(x => x.id === t.id) &&
      !(t.col === 'registers' && !num(t.rec.register) && !num(t.rec.check)) &&
      !(t.col === 'photos' && t.rec.cashId && db.deleted.some(x => x.col === 'cash' && x.id === t.rec.cashId)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function trashCard() {
  const list = trashList();
  return `<details class="card"><summary><span><b>Корзина</b><span class="sub">Удалённое за 30 дней можно вернуть</span></span><span class="badge">${list.length}</span></summary>
    ${list.length ? list.map(t => { const [a, b, c] = trashLabel(t); return `<div class="item"><span>${esc(a)}<span class="sub">${esc(b)} · удалено ${new Date(t.updatedAt).toLocaleDateString('ru-RU')}</span></span>
      <span class="trashr"><span class="num">${esc(c)}</span><button data-act="restore" data-id="${t.id}" data-col="${t.col}">Вернуть</button></span></div>`; }).join('')
    : '<p class="sub" style="margin-top:8px">Корзина пуста</p>'}
  </details>`;
}
function backupBanner() {
  if (VIEWER || !db.points.length) return '';
  const days = db.lastBackup ? Math.floor((Date.now() - db.lastBackup) / 864e5) : null;
  if (days !== null && days < 7) return '';
  return `<section class="card status warn backupnote"><span>${days === null ? 'Резервной копии ещё не было.' : 'Последняя резервная копия — ' + days + ' дн. назад.'}</span>
    <button class="primary" data-act="export">Сохранить копию</button></section>`;
}

function cloudCard() {
  if (!syncState.enabled) return `<section class="card"><h2>Облако</h2>
    <p class="sub">Облако ещё не подключено. После подключения начальник сможет смотреть отчёты со своего телефона.</p></section>`;
  if (!syncState.user) return `<section class="card"><h2>Облако</h2>
    <p class="sub" style="margin-bottom:10px">Войдите, чтобы данные отправлялись в облако и начальник их видел.</p>
    <form data-form="login" class="stack">
      <label class="fld"><span>Почта</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="fld"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Войти</button>
      <button type="button" class="ghost" data-act="resetPw">Забыли пароль?</button>
      ${syncState.error ? `<p class="status bad">${esc(syncState.error)}</p>` : ''}
    </form></section>`;
  return `<section class="card"><h2>Облако <span class="badge ok">подключено</span></h2>
    <p>Вход: <b>${esc(syncState.user)}</b></p>
    <p class="sub" style="margin:6px 0 10px">Все записи отправляются в облако сами. Без интернета — отправятся, когда связь появится.
    Ссылка для начальника: <b>${esc(location.href.replace(/[^/]*$/, ''))}boss.html</b></p>
    <div class="stack"><button data-act="shareBoss">Отправить ссылку начальнику</button>
    <button data-act="changePw">Сменить мой пароль</button>
    <button class="ghost" data-act="logout">Выйти из облака</button></div></section>
  ${bossAccessCard()}`;
}
// Пароль начальника меняет только бухгалтер — в консоли Firebase
const FB_USERS = 'https://console.firebase.google.com/project/gyros-c438c/authentication/users';
function bossAccessCard() {
  return `<details class="card"><summary><span><b>Доступ начальника</b><span class="sub">Сменить ему пароль или закрыть доступ</span></span></summary>
    <p class="sub" style="margin:8px 0">Пароль начальника знаете и меняете только вы. Сам он сбросить или поменять пароль не может. Посмотреть старый пароль нельзя никому — можно только задать новый.</p>
    <p><b>Задать новый пароль:</b></p>
    <ol class="steps"><li>Откройте Firebase (кнопка ниже) на компьютере.</li>
      <li>У почты начальника нажмите ⋮ → <b>Delete account</b>.</li>
      <li>Нажмите <b>Add user</b>, введите ту же почту и новый пароль.</li>
      <li>Скажите начальнику новый пароль. Все данные останутся — они не привязаны к паролю.</li></ol>
    <p><b>Временно закрыть доступ:</b> ⋮ → <b>Disable account</b>. Вернуть — ⋮ → <b>Enable account</b>.</p>
    <p class="sub" style="margin:6px 0 10px">В той же таблице в колонке <b>Signed In</b> видно, когда начальник последний раз входил.</p>
    <a class="btnlink" href="${FB_USERS}" target="_blank" rel="noopener">Открыть пользователей в Firebase</a>
  </details>`;
}

/* ================= Фото ================= */
// Фото хранятся в IndexedDB телефона (там много места), в облако уходят отдельно.
const PDB = (() => {
  let op;
  const open = () => op || (op = new Promise((res, rej) => {
    const r = indexedDB.open(VIEWER ? 'kassa-view-photos' : 'kassa-photos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('p', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = (mode, fn) => open().then(d => new Promise((res, rej) => {
    const t = d.transaction('p', mode); const req = fn(t.objectStore('p'));
    t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
  return {
    get: id => run('readonly', s => s.get(id)),
    put: rec => run('readwrite', s => s.put(rec)),
    del: id => run('readwrite', s => s.delete(id)),
    all: () => run('readonly', s => s.getAll()),
    clear: () => run('readwrite', s => s.clear()),
  };
})();
const photoUrl = {};
const cashPhotos = cid => db.photos.filter(p => p.cashId === cid);

function photoGrid(list) {
  if (!list.length) return '';
  return `<div class="phgrid">${list.map(p => `<button type="button" class="ph" data-act="openPhoto" data-id="${p.id}"><img data-photo="${p.id}" alt="Фото"></button>`).join('')}</div>`;
}
function hydratePhotos() {
  document.querySelectorAll('img[data-photo]:not([src])').forEach(img => {
    if (img.dataset.loading) return;
    img.dataset.loading = '1';
    loadPhoto(img.dataset.photo).then(src => {
      delete img.dataset.loading;
      if (src) img.src = src; else img.parentElement.classList.add('missing');
    });
  });
}
async function loadPhoto(id) {
  if (photoUrl[id]) return photoUrl[id];
  let r = null;
  try { r = await PDB.get(id); } catch (e) {}
  if ((!r || !r.data) && window.Sync && window.Sync.getPhoto) {
    const d = await window.Sync.getPhoto(id).catch(() => null);
    if (d && d.data) { r = { id, data: d.data, synced: true }; PDB.put(r).catch(() => {}); }
  }
  return r && r.data ? (photoUrl[id] = r.data) : null;
}
// Сжимаем: до 1280 px, JPEG. Чек остаётся читаемым, весит ~150–300 КБ.
function compressImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let max = 1280, q = 0.7;
      const draw = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', q);
      };
      let out = draw();
      while (out.length > 700000 && max > 500) { max = Math.round(max * 0.8); q = Math.max(0.5, q - 0.05); out = draw(); }
      res(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('bad image')); };
    img.src = url;
  });
}
async function addPhotos(files, link) {
  if (!files.length) return;
  toast('Сохраняем фото…');
  let n = 0;
  for (const f of files) {
    try {
      const data = await compressImage(f);
      const id = uid();
      await PDB.put({ id, data, synced: false });
      photoUrl[id] = data;
      db.photos.push(stamp({ id, date: link.date, pointId: link.pointId, cashId: link.cashId || '' }));
      n++;
    } catch (e) { toast('Не удалось сохранить фото'); }
  }
  if (n) { save(); safeRender(); toast(n === 1 ? 'Фото добавлено' : 'Добавлено фото: ' + n); }
}
function removePhoto(p) {
  removeRec('photos', p);
  const data = photoUrl[p.id] || null;
  delete photoUrl[p.id];
  PDB.get(p.id).catch(() => null).then(r => PDB.put({ id: p.id, data: (r && r.data) || data, deleted: true, deletedAt: Date.now(), synced: false })).catch(() => {});
}
function unDeletePhoto(id) {
  PDB.get(id).then(r => { if (r && r.data) return PDB.put({ id, data: r.data, synced: false }); }).catch(() => {});
}
// Чистка: удалённые больше 30 дней назад фото и пометки удаления
function purgeOld() {
  const old = Date.now() - MONTH_MS;
  const before = db.deleted.length;
  db.deleted = db.deleted.filter(t => t.updatedAt > old || (!t.synced && window.FIREBASE_CONFIG));
  if (db.deleted.length !== before) save(true);
  PDB.all().then(list => list.forEach(r => { if (r.deleted && r.synced && (r.deletedAt || 0) < old) PDB.del(r.id).catch(() => {}); })).catch(() => {});
}
function refreshSheetPhotos(cid) {
  const el = $('#sheetPhotos');
  if (el && cid) { el.innerHTML = photoGrid(cashPhotos(cid)) || '<p class="sub">Нет фото</p>'; hydratePhotos(); }
}
function openPhoto(id) {
  closePhoto();
  const p = db.photos.find(x => x.id === id);
  const v = document.createElement('div');
  v.id = 'photoView';
  v.innerHTML = `<div class="pv-wrap"><img alt="Фото"></div>
    <div class="pv-bar">${p ? `<span class="pv-cap">${p.cashId ? 'Наличка' : esc(pointName(p.pointId))} · ${fmtShort(p.date)}</span>` : ''}
    ${VIEWER ? '' : `<button class="danger" data-act="delPhoto" data-id="${id}">Удалить</button>`}
    <button class="primary" data-act="closePhoto">Закрыть</button></div>`;
  document.body.appendChild(v);
  const img = v.querySelector('img');
  img.onclick = () => img.classList.toggle('zoom');
  loadPhoto(id).then(src => { if (src) img.src = src; else toast('Фото ещё не загружено'); });
}
function closePhoto() { const v = $('#photoView'); if (v) v.remove(); }

/* ================= Окно редактирования ================= */
function fieldHtml(f) {
  const lab = `<span>${esc(f.label)}</span>`;
  if (f.type === 'select') return `<label class="fld">${lab}<select name="${f.name}">${opts(f.options, f.value)}</select></label>`;
  if (f.type === 'check') return `<label class="chk"><input type="checkbox" name="${f.name}"${f.value ? ' checked' : ''}><span>${esc(f.label)}</span></label>`;
  if (f.type === 'note') return `<p class="sub">${esc(f.label)}</p>`;
  if (f.type === 'html') return f.html;
  if (f.type === 'password') return `<label class="fld">${lab}<input name="${f.name}" type="password" autocomplete="${f.auto || 'new-password'}"></label>`;
  const extra = f.type === 'number' ? ' inputmode="decimal" autocomplete="off"' : f.type === 'date' ? ' type="date"' : f.type === 'month' ? ' type="month"' : ' autocomplete="off"';
  return `<label class="fld">${lab}<input name="${f.name}"${extra} value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
}
function openSheet({ title, fields, onSave, onDelete, saveLabel, deleteConfirm }) {
  const el = $('#sheet');
  el.innerHTML = `<div class="backdrop" data-act="closeSheet"></div>
    <form class="panel" id="sheetForm"><h3>${esc(title)}</h3>${fields.map(fieldHtml).join('')}
    <div class="btns">${onDelete ? '<button type="button" class="danger" id="sheetDel">Удалить</button>' : ''}
    <button type="button" class="ghost" data-act="closeSheet">Отмена</button>
    <button class="primary">${saveLabel || 'Сохранить'}</button></div></form>`;
  el.classList.add('open');
  const f = $('#sheetForm');
  f.onsubmit = e => {
    e.preventDefault();
    const v = {};
    fields.forEach(fd => { if (fd.name) { const i = f.elements[fd.name]; v[fd.name] = fd.type === 'check' ? i.checked : fd.type === 'password' ? i.value : i.value.trim(); } });
    if (onSave(v) === false) return;
    closeSheet(); save(); render();
  };
  if (onDelete) $('#sheetDel').onclick = () => {
    if (!confirm(deleteConfirm || 'Удалить запись?')) return;
    onDelete(); closeSheet(); save(); render(); toast('Удалено');
  };
  const first = f.querySelector('input:not([type=checkbox]),select');
  if (first) setTimeout(() => first.focus(), 60);
}
function closeSheet() { $('#sheet').classList.remove('open'); $('#sheet').innerHTML = ''; }

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ================= Действия ================= */
function amountSheet(kind, rec) {
  const isFood = kind === 'food';
  const list = isFood ? db.food : db.advances;
  openSheet({
    title: isFood ? 'Питание по чеку' : 'Аванс',
    fields: [
      { name: 'who', label: isFood ? 'Кто' : 'Кому', type: 'select', options: peopleOpts(rec.pointId, isFood, rec.employeeId), value: rec.employeeId },
      { name: 'amount', label: 'Сумма', type: 'number', value: rec.amount },
      { name: 'date', label: 'Дата', type: 'date', value: rec.date },
    ],
    onSave: v => {
      if (num(v.amount) <= 0) { toast('Введите сумму'); return false; }
      rec.employeeId = v.who; rec.amount = num(v.amount); if (v.date) rec.date = v.date; stamp(rec);
    },
    onDelete: () => removeRec(isFood ? 'food' : 'advances', rec),
  });
}

function empSheet(e) {
  const isNew = !e;
  e = e || { pointId: ui.pointId || sortedPoints()[0]?.id };
  const used = !isNew && (db.food.some(f => f.employeeId === e.id) || db.advances.some(a => a.employeeId === e.id) || db.fines.some(x => x.employeeId === e.id));
  openSheet({
    title: isNew ? 'Новый сотрудник' : 'Сотрудник',
    fields: [
      { name: 'name', label: 'Имя', value: e.name },
      { name: 'position', label: 'Должность', value: e.position },
      { name: 'pointId', label: 'Точка', type: 'select', options: sortedPoints().map(p => ({ v: p.id, t: p.name })), value: e.pointId },
      { name: 'salary', label: 'Зарплата в месяц', type: 'number', value: isNew ? '' : salaryFor(e, today().slice(0, 7)) },
      ...(isNew ? [] : [{ name: 'salaryFrom', label: 'Если меняете зарплату — с какого месяца (прошлые месяцы не изменятся)', type: 'month', value: today().slice(0, 7) }]),
      { name: 'hired', label: 'Начал работать (необязательно)', type: 'date', value: e.hired },
      ...(isNew ? [] : [
        { name: 'fired', label: 'Последний рабочий день (если уволен)', type: 'date', value: e.fired },
        { name: 'archived', label: 'Уволен (скрыть из списков, история останется)', type: 'check', value: e.archived },
      ]),
      ...(Array.isArray(e.salaryHist) && e.salaryHist.length > 1 ? [{ type: 'note', label: 'История зарплаты: ' +
        [...e.salaryHist].sort((a, b) => a.from.localeCompare(b.from)).map(h => (h.from === '2000-01' ? 'раньше' : 'с ' + fmtMonth(h.from).toLowerCase()) + ' — ' + money(h.amount)).join('; ') }] : []),
      ...(used ? [{ type: 'note', label: 'У сотрудника есть записи, поэтому его нельзя удалить. Отметьте «Уволен».' }] : []),
    ],
    onSave: v => {
      if (!v.name) { toast('Введите имя'); return false; }
      const newSal = num(v.salary);
      if (isNew) e.salaryHist = [{ from: '2000-01', amount: newSal }];
      else {
        const from = v.salaryFrom || today().slice(0, 7);
        if (salaryFor(e, from) !== newSal) {
          let h = Array.isArray(e.salaryHist) && e.salaryHist.length ? e.salaryHist.slice() : [{ from: '2000-01', amount: num(e.salary) }];
          h = h.filter(x => x.from !== from);
          h.push({ from, amount: newSal });
          e.salaryHist = h.sort((a, b) => a.from.localeCompare(b.from));
        }
      }
      if (v.hired && v.fired && v.fired < v.hired) { toast('Дата увольнения раньше даты начала'); return false; }
      Object.assign(e, { name: v.name, position: v.position, pointId: v.pointId, hired: v.hired || '', fired: v.fired || '', archived: !!v.archived });
      e.salary = salaryFor(e, '9999-12');
      if (isNew) { e.id = uid(); db.employees.push(e); }
      stamp(e); toast('Сохранено');
    },
    onDelete: isNew || used ? null : () => removeRec('employees', e),
    deleteConfirm: 'Удалить сотрудника?',
  });
}

function pointSheet(p) {
  const isNew = !p;
  p = p || {};
  const used = !isNew && (db.employees.some(e => e.pointId === p.id) || db.registers.some(r => r.pointId === p.id) ||
    db.food.some(f => f.pointId === p.id) || db.advances.some(a => a.pointId === p.id) || db.cash.some(c => c.pointId === p.id) || db.stock.some(s => s.pointId === p.id));
  openSheet({
    title: isNew ? 'Новая точка' : 'Точка',
    fields: [
      { name: 'name', label: 'Название или адрес', value: p.name, placeholder: 'Кафе на Ленина' },
      { name: 'rent', label: 'Аренда в месяц (необязательно)', type: 'number', value: p.rent },
      { name: 'rentDay', label: 'День оплаты аренды (1–28)', type: 'number', value: p.rentDay || 1 },
      { type: 'note', label: 'Если указать аренду, во вкладке «Наличка» каждый месяц будет напоминание с кнопкой «Внести».' },
      ...(used ? [{ type: 'note', label: 'У точки есть сотрудники или записи, поэтому её нельзя удалить.' }] : []),
    ],
    onSave: v => {
      if (!v.name) { toast('Введите название'); return false; }
      p.name = v.name;
      const rent = num(v.rent);
      // Напоминаем с месяца, когда аренду указали впервые (не за прошлые месяцы)
      if (rent && !num(p.rent)) p.rentSince = today().slice(0, 7);
      p.rent = rent;
      p.rentDay = Math.min(28, Math.max(1, Math.round(num(v.rentDay)) || 1));
      if (isNew) { p.id = uid(); db.points.push(p); if (!ui.pointId) ui.pointId = p.id; }
      stamp(p); toast('Сохранено');
    },
    onDelete: isNew || used ? null : () => removeRec('points', p),
    deleteConfirm: 'Удалить точку?',
  });
}

const actions = {
  tab: t => { ui.tab = t.dataset.tab; saveUi(); render(); scrollTo(0, 0); },
  prevDay: () => { ui.date = addDays(ui.date, -1); render(); },
  nextDay: () => { ui.date = addDays(ui.date, 1); render(); },
  prevMonth: () => { ui.month = addMonths(ui.month, -1); render(); },
  nextMonth: () => { ui.month = addMonths(ui.month, 1); render(); },
  goDay: t => { ui.tab = 'day'; ui.date = t.dataset.date; ui.pointId = t.dataset.point; saveUi(); render(); scrollTo(0, 0); },
  closeSheet: () => closeSheet(),
  editFood: t => { const r = db.food.find(x => x.id === t.dataset.id); if (r) amountSheet('food', r); },
  editAdv: t => { const r = db.advances.find(x => x.id === t.dataset.id); if (r) amountSheet('adv', r); },
  editFine: t => { const r = db.fines.find(x => x.id === t.dataset.id); if (r) fineSheet(r); },
  editCash: t => {
    const c = db.cash.find(x => x.id === t.dataset.id); if (!c) return;
    openSheet({
      title: 'Наличка · ' + fmtDay(c.date),
      fields: [
        { name: 'cash', label: 'Наличные', type: 'number', value: c.cash },
        { name: 'added', label: 'Добавлено', type: 'number', value: c.added },
        { name: 'expense', label: 'Расход', type: 'number', value: c.expense },
        { name: 'catId', label: 'Категория', type: 'select', options: catOpts(c.catId), value: c.catId || '' },
        { name: 'note', label: 'Комментарий', value: c.note },
        ...(c.stockId ? [{ type: 'note', label: 'Эта запись создана приходом на склад — сумму лучше менять там (вкладка «Склад»).' }] : []),
        { name: 'date', label: 'Дата', type: 'date', value: c.date },
        { type: 'html', html: `<div class="fld"><span>Фото чека</span><div id="sheetPhotos">${photoGrid(cashPhotos(c.id)) || '<p class="sub">Нет фото</p>'}</div>
          <label class="filebtn photobtn">📷 Добавить фото<input type="file" accept="image/*" multiple data-change="cashPhotos" data-id="${c.id}"></label></div>` },
      ],
      onSave: v => {
        Object.assign(c, { cash: num(v.cash), added: num(v.added), expense: num(v.expense), note: v.note, catId: v.catId || '', date: v.date || c.date }); stamp(c);
        cashPhotos(c.id).forEach(p => { if (p.date !== c.date) { p.date = c.date; stamp(p); } });
      },
      onDelete: () => { cashPhotos(c.id).forEach(removePhoto); removeRec('cash', c); },
    });
    hydratePhotos();
  },
  setDate: t => { ui.date = t.dataset.date; render(); scrollTo(0, 0); },
  resetPw: t => {
    const f = t.closest('form'), email = f && f.elements.email.value.trim();
    if (!email) { toast('Введите почту, на неё придёт письмо'); f && f.elements.email.focus(); return; }
    if (!window.Sync) { toast('Облако ещё загружается'); return; }
    window.Sync.resetPassword(email).then(r => {
      if (r.ok) alert('Письмо отправлено на ' + email + '.\n\nОткройте его и нажмите на ссылку, чтобы задать новый пароль. Если письма нет — проверьте папку «Спам».');
      else toast(r.error);
    });
  },
  changePw: () => openSheet({
    title: 'Сменить мой пароль',
    fields: [
      { name: 'old', label: 'Старый пароль', type: 'password', auto: 'current-password' },
      { name: 'new1', label: 'Новый пароль (минимум 6 символов)', type: 'password' },
      { name: 'new2', label: 'Новый пароль ещё раз', type: 'password' },
      { type: 'note', label: 'Не помните старый? Выйдите из облака и нажмите «Забыли пароль?» — придёт письмо.' },
    ],
    saveLabel: 'Сменить пароль',
    onSave: v => {
      if (!v.old || !v.new1) { toast('Заполните все поля'); return false; }
      if (v.new1 !== v.new2) { toast('Новые пароли не совпадают'); return false; }
      if (v.new1.length < 6) { toast('Нужно минимум 6 символов'); return false; }
      if (!window.Sync) { toast('Облако ещё загружается'); return false; }
      window.Sync.changePassword(v.old, v.new1).then(r => r.ok ? alert('Пароль изменён. Запомните его.') : toast(r.error));
    },
  }),
  payRent: t => {
    const p = point(t.dataset.point), m = t.dataset.month; if (!p) return;
    // Дата: выбранный день, если он в этом месяце; иначе сегодня или конец того месяца
    const date = ui.date.startsWith(m) ? ui.date : today().startsWith(m) ? today() : monthEnd(m);
    if (!confirm(`Внести аренду ${p.name} за ${fmtMonth(m).toLowerCase()}: ${money(p.rent)}?\nДата: ${fmtDay(date)}. Сумму потом можно исправить.`)) return;
    db.cash.push(stamp({ id: uid(), date, pointId: p.id, cash: 0, added: 0, expense: num(p.rent), catId: catByName('Аренда'),
      note: 'Аренда ' + p.name + ' за ' + fmtMonth(m).toLowerCase(), rentFor: m }));
    save(); render(); toast('Аренда внесена');
  },
  markClosed: t => {
    const d = t.dataset.date, pid = t.dataset.point;
    let r = getReg(d, pid);
    if (!r) { r = { id: uid(), date: d, pointId: pid, register: 0, check: 0 }; db.registers.push(r); }
    r.closed = true; stamp(r); save(); render(); toast('Отмечено: выходной');
  },
  restore: t => {
    const tomb = db.deleted.find(x => x.id === t.dataset.id && x.col === t.dataset.col);
    if (!tomb || !restoreRec(tomb)) { toast('Не удалось вернуть'); return; }
    save(); render(); toast('Возвращено');
  },
  exportPhotos: () => exportDb(true),
  addProduct: () => productSheet(null),
  editProduct: t => productSheet(prod(t.dataset.id)),
  editStock: t => { const s = db.stock.find(x => x.id === t.dataset.id); if (s) stockSheet(s); },
  wcount: () => countSheet('wcount'),
  pcount: () => countSheet('pcount'),
  addCat: () => catSheet(null),
  editCat: t => catSheet(db.cats.find(c => c.id === t.dataset.id)),
  exportXlsx: t => exportXlsx(t.dataset.month || ($('#xlsMonth') && $('#xlsMonth').value) || ui.month),
  paySheet: t => {
    const e = emp(t.dataset.id); if (!e) return;
    const m = ui.month, cur = e.paid && e.paid[m], inM = x => x.date.startsWith(m) && x.employeeId === e.id;
    const calc = Math.round(accrued(e, m).amount) - sum(db.food.filter(inM), 'amount') - sum(db.advances.filter(inM), 'amount') - sum(db.fines.filter(inM), 'amount');
    const defDate = today().startsWith(m) ? today() : (today() > m ? addDays(addMonths(m, 1) + '-01', -1) : m + '-01');
    openSheet({
      title: 'Выдача · ' + e.name + ' · ' + fmtMonth(m).toLowerCase(),
      fields: [
        { type: 'note', label: 'По расчёту к выдаче: ' + money(calc) },
        { name: 'amount', label: 'Выдано', type: 'number', value: cur ? cur.amount : Math.max(0, calc) },
        { name: 'date', label: 'Дата выдачи', type: 'date', value: cur ? cur.date : defDate },
        { name: 'fromCash', label: 'Выдано из общей налички (вычесть из остатка)', type: 'check', value: cur ? cur.fromCash : true },
      ],
      saveLabel: 'Отметить выдачу',
      onSave: v => {
        if (num(v.amount) < 0) { toast('Сумма не может быть меньше нуля'); return false; }
        e.paid = Object.assign({}, e.paid, { [m]: { amount: num(v.amount), date: v.date || defDate, fromCash: !!v.fromCash } });
        stamp(e); toast('Выдача отмечена');
      },
      onDelete: cur ? () => { const p = Object.assign({}, e.paid); delete p[m]; e.paid = p; stamp(e); } : null,
      deleteConfirm: 'Отменить отметку о выдаче?',
    });
  },
  openPhoto: t => openPhoto(t.dataset.id),
  closePhoto: () => closePhoto(),
  delPhoto: t => {
    const p = db.photos.find(x => x.id === t.dataset.id); if (!p) return;
    if (!confirm('Удалить фото?')) return;
    removePhoto(p); save(); closePhoto(); refreshSheetPhotos(p.cashId); safeRender(); toast('Фото удалено');
  },
  addPoint: () => pointSheet(null),
  editPoint: t => pointSheet(point(t.dataset.id)),
  addEmp: () => empSheet(null),
  editEmp: t => empSheet(emp(t.dataset.id)),
  export: () => exportDb(),
  wipe: () => {
    if (!confirm('Удалить ВСЕ данные с этого телефона? Сначала сделайте резервную копию!')) return;
    if (!confirm('Точно удалить? Это нельзя отменить.')) return;
    db = emptyDb(); save(true);
    if (window.Sync) window.Sync.signOut();
    render(); toast('Данные удалены с телефона');
  },
  logout: () => {
    if (!confirm(VIEWER ? 'Выйти?' : 'Выйти из облака? Записи перестанут отправляться, пока не войдёте снова.')) return;
    if (window.Sync) window.Sync.signOut();
  },
  shareBoss: () => {
    const url = location.href.replace(/[^/]*$/, '') + 'boss.html';
    if (navigator.share) navigator.share({ title: 'Касса — отчёты', url }).catch(() => {});
    else { navigator.clipboard?.writeText(url).then(() => toast('Ссылка скопирована'), () => prompt('Ссылка для начальника:', url)); }
  },
};
// Действия, которые меняют данные — у начальника недоступны
const EDIT_ACTS = new Set(['editFood', 'editAdv', 'editCash', 'addPoint', 'editPoint', 'addEmp', 'editEmp', 'wipe', 'export', 'delPhoto', 'paySheet', 'restore', 'exportPhotos', 'addProduct', 'editProduct', 'editStock', 'wcount', 'pcount', 'addCat', 'editCat', 'markClosed', 'editFine', 'resetPw', 'changePw', 'payRent']);

const changes = {
  point: t => { ui.pointId = t.value; saveUi(); render(); },
  payPoint: t => { ui.payPoint = t.value; saveUi(); render(); },
  date: t => { if (t.value) { ui.date = t.value; render(); } },
  importBackup: t => readFiles(t.files).then(([f]) => {
    t.value = '';
    if (!f) return;
    let data;
    try { data = JSON.parse(f.text); } catch (e) { toast('Файл повреждён'); return; }
    if (!data || !Array.isArray(data.points)) { toast('Это не резервная копия'); return; }
    if (!confirm('Заменить все данные на этом телефоне данными из копии?')) return;
    const keepSync = db.sync;
    const photoData = data.photoData || {}; delete data.photoData;
    Object.entries(photoData).forEach(([id, src]) => {
      photoUrl[id] = src;
      PDB.put({ id, data: src, synced: false }).catch(() => {});
    });
    db = normalizeDb(data);
    // Всё из копии заново отправим в облако
    db.sync = { lastPush: 0, pull: keepSync.pull || {} };
    COLS.forEach(c => db[c].forEach(r => { delete r.syncedAt; r.updatedAt = Math.max(r.updatedAt || 0, Date.now()); }));
    save(); render(); toast('Восстановлено');
  }),
  importOld: t => readFiles(t.files).then(files => { t.value = ''; importOld(files); }),
  dayPhotos: t => { const fl = [...t.files]; t.value = ''; addPhotos(fl, { date: ui.date, pointId: ui.pointId }); },
  cashPhotos: t => {
    const c = db.cash.find(x => x.id === t.dataset.id); const fl = [...t.files]; t.value = '';
    if (c) addPhotos(fl, { date: c.date, pointId: c.pointId, cashId: c.id }).then(() => refreshSheetPhotos(c.id));
  },
  cashFormPhotos: t => {
    pendingCashFiles = [...t.files];
    const el = $('#cashPhotoCount'); if (el) el.textContent = pendingCashFiles.length ? ' · выбрано: ' + pendingCashFiles.length : '';
  },
};
let pendingCashFiles = [];

function stockForm(f, kind) {
  const pid = f.elements.prod.value, q = num(f.elements.qty.value);
  if (!pid) { toast('Сначала добавьте продукт'); return; }
  if (q <= 0) { toast('Введите количество'); f.elements.qty.focus(); return; }
  const s = { id: uid(), createdAt: Date.now(), date: ui.date, kind, productId: pid, qty: q, pointId: '' };
  if (kind === 'out') { s.pointId = f.elements.point.value; ui.stockPoint = s.pointId; }
  else { s.amount = num(f.elements.amount.value); s.fromCash = f.elements.fromCash.checked; }
  ui.stockProd = pid;
  db.stock.push(stamp(s));
  if (kind === 'in') syncStockCash(s);
  const rest = whLedger(pid, ui.date).rest;
  save(); render();
  toast((kind === 'out' ? 'Выдано ' : 'Приход ') + qtyStr(q, pid) + ' · на складе ' + qtyStr(rest, pid));
  const inp = document.querySelector(`[data-form="${kind === 'out' ? 'stockOut' : 'stockIn'}"] [name=qty]`); if (inp) inp.focus();
}

const forms = {
  stockOut: f => stockForm(f, 'out'),
  stockIn: f => stockForm(f, 'in'),
  login: f => {
    if (!window.Sync) { toast('Облако ещё загружается, попробуйте через секунду'); return; }
    const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Входим…';
    window.Sync.signIn(f.elements.email.value.trim(), f.elements.password.value)
      .finally(() => { btn.disabled = false; btn.textContent = 'Войти'; });
  },
  food: f => addAmount(f, 'food'),
  adv: f => addAmount(f, 'adv'),
  fine: f => addFine(f),
  cash: f => {
    const v = k => num(f.elements[k].value);
    const files = pendingCashFiles; pendingCashFiles = [];
    if (!v('cash') && !v('added') && !v('expense') && !files.length) { toast('Введите хотя бы одну сумму'); return; }
    const c = stamp({ id: uid(), date: ui.date, pointId: '', cash: v('cash'), added: v('added'), expense: v('expense'), note: f.elements.note.value.trim(), catId: f.elements.cat.value });
    db.cash.push(c);
    save(); render(); toast('Добавлено');
    if (files.length) addPhotos(files, { date: c.date, pointId: c.pointId, cashId: c.id });
  },
};

function addFine(f) {
  const who = f.elements.who.value, amount = num(f.elements.amount.value), note = f.elements.note.value.trim();
  if (!who) { toast('Добавьте сотрудников во вкладке «Ещё»'); return; }
  if (amount <= 0) { toast('Введите сумму'); f.elements.amount.focus(); return; }
  db.fines.push(stamp({ id: uid(), date: ui.date, pointId: ui.pointId, employeeId: who, amount, note }));
  ui.fineWho = who;
  save(); render(); toast('Штраф: ' + empName(who) + ' ' + money(amount));
}
function fineSheet(r) {
  openSheet({
    title: 'Штраф',
    fields: [
      { name: 'who', label: 'Кому', type: 'select', options: peopleOpts(r.pointId, false, r.employeeId), value: r.employeeId },
      { name: 'amount', label: 'Сумма', type: 'number', value: r.amount },
      { name: 'note', label: 'Причина', value: r.note },
      { name: 'date', label: 'Дата', type: 'date', value: r.date },
    ],
    onSave: v => {
      if (num(v.amount) <= 0) { toast('Введите сумму'); return false; }
      Object.assign(r, { employeeId: v.who, amount: num(v.amount), note: v.note, date: v.date || r.date }); stamp(r);
    },
    onDelete: () => removeRec('fines', r),
  });
}

function addAmount(f, kind) {
  const who = f.elements.who.value, amount = num(f.elements.amount.value);
  if (!who) { toast('Добавьте сотрудников во вкладке «Ещё»'); return; }
  if (amount <= 0) { toast('Введите сумму'); f.elements.amount.focus(); return; }
  (kind === 'food' ? db.food : db.advances).push(stamp({ id: uid(), date: ui.date, pointId: ui.pointId, employeeId: who, amount }));
  // В чеке сразу переходим к следующему человеку — удобно делить чек по списку
  const sel = f.elements.who;
  const next = kind === 'food' && sel.selectedIndex < sel.options.length - 1 ? sel.options[sel.selectedIndex + 1].value : who;
  if (kind === 'food') ui.foodWho = next; else ui.advWho = who;
  save(); render(); toast('Добавлено: ' + empName(who) + ' ' + money(amount));
  const inp = document.querySelector(`[data-form="${kind}"] [name=amount]`);
  if (inp) inp.focus();
}

document.addEventListener('click', e => {
  const nav = e.target.closest('nav button');
  if (nav) { actions.tab(nav); return; }
  const t = e.target.closest('[data-act]');
  if (t && actions[t.dataset.act] && !(VIEWER && EDIT_ACTS.has(t.dataset.act))) actions[t.dataset.act](t, e);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.change && changes[t.dataset.change]) changes[t.dataset.change](t);
  else if (t.dataset.reg && !VIEWER) saveReg(t);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  forms[f.dataset.form](f);
});

// Касса сохраняется без перерисовки, чтобы не сбивать ввод
function saveReg(t) {
  const pid = ui.pointId, d = ui.date;
  let r = getReg(d, pid);
  if (!r) { r = { id: uid(), date: d, pointId: pid, register: '', check: '' }; db.registers.push(r); }
  r[t.dataset.reg] = t.value.trim() === '' ? '' : num(t.value);
  if (num(r.register)) r.closed = false; // внесли кассу — значит, не выходной
  stamp(r);
  if (r.register === '' && r.check === '') removeRec('registers', r);
  save();
  $('#regSum').outerHTML = regSum(d, pid);
  $('#splitInfo').outerHTML = splitInfo(d, pid);
}

/* ================= Файлы ================= */
function readFiles(list) {
  return Promise.all([...(list || [])].map(file => file.text().then(text => ({ name: file.name.toLowerCase(), text }))));
}

async function exportDb(withPhotos) {
  let out = db, name = 'kassa-' + today() + '.json';
  if (withPhotos) {
    // Собираем фото: из телефона, а чего нет — из облака
    const photoData = {}; let miss = 0, i = 0;
    for (const p of db.photos) {
      if (++i % 10 === 0) toast('Собираем фото: ' + i + ' из ' + db.photos.length);
      const src = await loadPhoto(p.id).catch(() => null);
      if (src) photoData[p.id] = src; else miss++;
    }
    out = Object.assign({}, db, { photoData });
    name = 'kassa-foto-' + today() + '.json';
    if (miss) toast('Не удалось получить фото: ' + miss + ' (нет интернета?)');
  }
  db.lastBackup = Date.now(); save();
  shareFile(new Blob([JSON.stringify(out)], { type: 'application/json' }), name);
  render();
}
// Отдать файл: на телефоне — меню «Поделиться», иначе — скачать
function shareFile(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
}

/* ================= Excel (.xlsx без библиотек) ================= */
const XL = (() => {
  const enc = new TextEncoder();
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  // ZIP без сжатия
  function zip(files) {
    const parts = [], central = []; let off = 0;
    files.forEach(f => {
      const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data), sz = data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true);
      h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + sz;
    });
    const cd = central.reduce((s, a) => s + a.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cd, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  const x = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const col = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const serial = s => { const [y, m, d] = s.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  // Ячейка: число, строка или { d: 'YYYY-MM-DD' }. bold — номера жирных строк (0 = заголовок)
  function sheet(sh) {
    const rows = sh.rows.map((r, ri) => {
      const b = ri === 0 || (sh.bold && sh.bold.has(ri));
      return `<row r="${ri + 1}">` + r.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = col(ci) + (ri + 1);
        if (typeof v === 'number') return `<c r="${ref}" s="${b ? 4 : 3}"><v>${Math.round(v * 100) / 100}</v></c>`;
        if (v.d) return `<c r="${ref}" s="2"><v>${serial(v.d)}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${b ? ' s="1"' : ''}><is><t xml:space="preserve">${x(v)}</t></is></c>`;
      }).join('') + '</row>';
    }).join('');
    const cols = '<cols>' + sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
  }
  function book(sheets) {
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const files = [
      { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${NS} xmlns:r="${R}"><sheets>${sheets.map((s, i) => `<sheet name="${x(s.name.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>` },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheet(s) })),
    ];
    return zip(files);
  }
  return { book };
})();

// Отчёт за месяц: касса, питание, авансы, наличка, зарплата
function monthSheets(m) {
  const inM = r => r.date && r.date.startsWith(m);
  const byDP = (a, b) => a.date.localeCompare(b.date) || pointName(a.pointId).localeCompare(pointName(b.pointId), 'ru');
  const D = s => ({ d: s });

  // Касса
  const fs = {}; db.food.filter(inM).forEach(f => { const k = f.date + '|' + f.pointId; fs[k] = (fs[k] || 0) + num(f.amount); });
  const keys = new Set([...db.registers.filter(inM).map(r => r.date + '|' + r.pointId), ...Object.keys(fs)]);
  const regRows = [...keys].map(k => { const [date, pointId] = k.split('|'); return { date, pointId, r: getReg(date, pointId) }; }).sort(byDP);
  const kassa = { name: 'Касса', cols: [12, 20, 13, 11, 13, 13, 13], bold: new Set(),
    rows: [['Дата', 'Точка', 'Счёт кассы', 'Чек', 'Касса − чек', 'Разделено', 'Не разделено']] };
  const per = {};
  regRows.forEach(({ date, pointId, r }) => {
    const reg = num(r?.register), chk = num(r?.check), sp = fs[date + '|' + pointId] || 0;
    kassa.rows.push([D(date), pointName(pointId), reg, chk, reg - chk, sp, chk - sp]);
    const p = per[pointId] || (per[pointId] = [0, 0]); p[0] += reg; p[1] += chk;
  });
  kassa.rows.push([]);
  Object.entries(per).sort((a, b) => pointName(a[0]).localeCompare(pointName(b[0]), 'ru')).forEach(([pid, [reg, chk]]) => {
    kassa.bold.add(kassa.rows.length); kassa.rows.push(['Итого', pointName(pid), reg, chk, reg - chk]);
  });
  const tr = Object.values(per).reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
  kassa.bold.add(kassa.rows.length); kassa.rows.push(['Итого', 'Все точки', tr[0], tr[1], tr[0] - tr[1]]);

  // Питание и авансы
  const list = (name, arr, who) => {
    const sh = { name, cols: [12, 20, 24, 12], bold: new Set(), rows: [['Дата', 'Точка', who, 'Сумма']] };
    arr.filter(inM).sort(byDP).forEach(r => sh.rows.push([D(r.date), pointName(r.pointId), empName(r.employeeId), num(r.amount)]));
    sh.bold.add(sh.rows.length); sh.rows.push(['Итого', '', '', sum(arr.filter(inM), 'amount')]);
    return sh;
  };

  // Наличка
  const t = cashTimeline();
  let bal = balanceAt(addDays(m + '-01', -1), t);
  const cash = { name: 'Наличка', cols: [12, 13, 13, 13, 13, 13, 34, 14], bold: new Set(),
    rows: [['Дата', 'Наличные', 'Добавлено', 'Расход', 'Аванс', 'Зарплата', 'Комментарий', 'Остаток']] };
  cash.rows.push(['', '', '', '', '', '', 'Остаток на начало месяца', bal]);
  const tot = [0, 0, 0, 0, 0];
  t.dates.filter(d => d.startsWith(m)).forEach(d => {
    const x = t.days[d];
    x.entries.forEach(c => { bal += num(c.cash) + num(c.added) - num(c.expense); tot[0] += num(c.cash); tot[1] += num(c.added); tot[2] += num(c.expense);
      cash.rows.push([D(d), num(c.cash) || '', num(c.added) || '', num(c.expense) || '', '', '', [catName(c.catId), c.note].filter(Boolean).join(': '), bal]); });
    x.advs.forEach(a => { bal -= num(a.amount); tot[3] += num(a.amount);
      cash.rows.push([D(d), '', '', '', num(a.amount), '', 'Аванс: ' + empName(a.employeeId) + ' (' + pointName(a.pointId) + ')', bal]); });
    x.pays.forEach(p => { bal -= p.amount; tot[4] += p.amount;
      cash.rows.push([D(d), '', '', '', '', p.amount, 'Зарплата: ' + p.e.name + ' за ' + fmtMonth(p.m).toLowerCase(), bal]); });
  });
  cash.bold.add(cash.rows.length); cash.rows.push(['Итого', ...tot, 'Остаток на конец месяца', bal]);

  // Зарплата
  const foodM = db.food.filter(inM), advM = db.advances.filter(inM), fineM = db.fines.filter(inM);
  const pay = { name: 'Зарплата', cols: [18, 20, 16, 11, 9, 12, 11, 11, 11, 12, 12, 12], bold: new Set(),
    rows: [['Точка', 'Сотрудник', 'Должность', 'Оклад', 'Дней', 'Начислено', 'Питание', 'Аванс', 'Штраф', 'К выдаче', 'Выдано', 'Дата выдачи']] };
  const pt = [0, 0, 0, 0, 0, 0];
  db.employees.filter(e => foodM.some(f => f.employeeId === e.id) || advM.some(a => a.employeeId === e.id) || fineM.some(x => x.employeeId === e.id) || (e.paid && e.paid[m]) || (!e.archived && workDays(e, m).days > 0))
    .sort((a, b) => pointName(a.pointId).localeCompare(pointName(b.pointId), 'ru') || byName(a, b))
    .forEach(e => {
      const ac = accrued(e, m), s = Math.round(ac.amount), f = sum(foodM.filter(r => r.employeeId === e.id), 'amount'), a = sum(advM.filter(r => r.employeeId === e.id), 'amount'), fn = sum(fineM.filter(r => r.employeeId === e.id), 'amount');
      const pd = e.paid && e.paid[m];
      pt[0] += s; pt[1] += f; pt[2] += a; pt[3] += fn; pt[4] += s - f - a - fn; pt[5] += pd ? num(pd.amount) : 0;
      pay.rows.push([pointName(e.pointId), e.name + (e.archived ? ' (уволен)' : ''), e.position || '', ac.full, ac.days + '/' + ac.dim, s, f, a, fn, s - f - a - fn, pd ? num(pd.amount) : '', pd ? D(pd.date) : '']);
    });
  pay.bold.add(pay.rows.length); pay.rows.push(['Итого', '', '', '', '', pt[0], pt[1], pt[2], pt[3], pt[4], pt[5]]);
  const boss = foodM.filter(f => f.employeeId === BOSS);
  if (boss.length) {
    pay.rows.push([]);
    const bp = {}; boss.forEach(f => bp[f.pointId] = (bp[f.pointId] || 0) + num(f.amount));
    Object.entries(bp).forEach(([p, v]) => pay.rows.push([pointName(p), BOSS_NAME, 'в зарплату не входит', '', '', '', v]));
  }

  // Расходы по категориям
  const cats = { name: 'Расходы по категориям', cols: [26, 14, 8], bold: new Set(), rows: [['Категория', 'Сумма', '%']] };
  const ct = catTotals(m), ctSum = ct.reduce((a, x) => a + x[1], 0);
  ct.forEach(([k, v]) => cats.rows.push([k, v, ctSum ? Math.round(v / ctSum * 100) : 0]));
  cats.bold.add(cats.rows.length); cats.rows.push(['Итого', ctSum]);

  // Склад: остатки и расход по точкам
  const pts = sortedPoints();
  const stock = { name: 'Склад', cols: [20, 7, 12, 11, 12, ...pts.map(() => 14), 11, 14, 12], bold: new Set(),
    rows: [['Продукт', 'Ед.', 'На начало', 'Пришло', 'Сумма', ...pts.map(p => 'Расход: ' + p.name), 'Списано', 'Расход всего', 'На конец']] };
  sortedProducts(true).forEach(p => {
    const s = stockMonth(p.id, m);
    if (!s.start && !s.income && !s.total && !s.end) return;
    stock.rows.push([p.name, p.unit, s.start, s.income, s.spent || '', ...s.pts.map(t => t.use), s.off || '', s.total, s.end]);
  });
  const moves = { name: 'Движения склада', cols: [12, 18, 20, 10, 7, 20, 12], bold: new Set(),
    rows: [['Дата', 'Операция', 'Продукт', 'Кол-во', 'Ед.', 'Точка', 'Сумма']] };
  const kindName = { in: 'Приход', out: 'Выдача', wcount: 'Пересчёт склада', pcount: 'Пересчёт на точке' };
  db.stock.filter(inM).sort(stockSort).forEach(s => moves.rows.push([D(s.date), kindName[s.kind], prodName(s.productId), num(s.qty), unitOf(s.productId), s.pointId ? pointName(s.pointId) : '', num(s.amount) || '']));

  const pr = profitMonth(m);
  const profit = { name: 'Прибыль', cols: [34, 14, 40], bold: new Set(), rows: [['Статья', 'Сумма', 'Пояснение']] };
  profit.rows.push(['Выручка (счёт кассы)', pr.R, ''], ['Питание по чеку', -pr.C, 'еда сотрудников и гостей — денег не пришло'],
    ['Удержано за питание', pr.F, 'вычтено из зарплаты'], ['Удержано штрафов', pr.N, 'вычтено из зарплаты'], ['Зарплата (начислено)', -pr.S, pr.isCur ? 'за прошедшие дни месяца' : '']);
  pr.cats.forEach(([k, v]) => profit.rows.push(['Расход: ' + k, -v, '']));
  if (pr.P) profit.rows.push(['Продукты не из налички', -pr.P, 'приход на склад']);
  profit.bold.add(profit.rows.length); profit.rows.push(['Прибыль', pr.profit, pr.isCur ? 'месяц ещё не закончился' : '']);

  const fineList = () => {
    const sh = { name: 'Штрафы', cols: [12, 20, 24, 12, 34], bold: new Set(), rows: [['Дата', 'Точка', 'Сотрудник', 'Сумма', 'Причина']] };
    db.fines.filter(inM).sort(byDP).forEach(r => sh.rows.push([D(r.date), pointName(r.pointId), empName(r.employeeId), num(r.amount), r.note || '']));
    sh.bold.add(sh.rows.length); sh.rows.push(['Итого', '', '', sum(db.fines.filter(inM), 'amount')]);
    return sh;
  };
  const out = [kassa, profit, list('Питание', db.food, 'Кто'), list('Авансы', db.advances, 'Сотрудник'), fineList(), cash, cats, pay];
  if (db.products.length) out.push(stock, moves);
  return out;
}
function exportXlsx(m) {
  try { shareFile(XL.book(monthSheets(m)), 'kassa-' + m + '.xlsx'); }
  catch (e) { toast('Не удалось создать файл'); }
}

// Старый формат даты dd.MM.yy → yyyy-MM-dd
function oldDate(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(String(s || '').trim());
  return m ? '20' + m[3] + '-' + m[2] + '-' + m[1] : null;
}

function importOld(files) {
  const get = n => { const f = files.find(x => x.name.startsWith(n)); if (!f) return null; try { return JSON.parse(f.text).items || []; } catch (e) { toast('Файл ' + f.name + ' повреждён'); return null; } };
  const points = get('messages'), emps = get('employees'), adv = get('advance'), daily = get('daily_cash'), book = get('cash_book');
  if (!points && !emps && !adv && !daily && !book) { toast('Не нашёл файлов старого приложения'); return; }

  const norm = s => String(s || '').trim().toLowerCase();
  const findPoint = n => db.points.find(p => norm(p.name) === norm(n));
  const findEmp = n => db.employees.find(e => norm(e.name) === norm(n));
  const addPoint = n => { let p = findPoint(n); if (!p && String(n || '').trim()) { p = stamp({ id: uid(), name: String(n).trim() }); db.points.push(p); } return p; };

  let cP = 0, cE = 0;
  (points || []).forEach(n => { if (!findPoint(n)) { addPoint(n); cP++; } });
  (emps || []).forEach(e => {
    if (findEmp(e.name)) return;
    const p = addPoint(e.point);
    db.employees.push(stamp({ id: uid(), name: String(e.name || '').trim(), position: e.position || '', pointId: p?.id || '', salary: num(e.salary) }));
    cE++;
  });

  const finish = target => {
    let cA = 0, cF = 0, cR = 0, cC = 0;
    (adv || []).forEach(a => {
      const d = oldDate(a.date); if (!d) return;
      let e = findEmp(a.employee);
      if (!e) { e = stamp({ id: uid(), name: String(a.employee || 'Без имени').trim(), position: '', pointId: target, salary: 0 }); db.employees.push(e); cE++; }
      if (!e.pointId) e.pointId = target;
      const rec = stamp({ id: uid(), date: d, pointId: e.pointId, employeeId: e.id, amount: num(a.amount) });
      if (a.type === 'Питание') { db.food.push(rec); cF++; } else { db.advances.push(rec); cA++; }
    });
    (daily || []).forEach(x => {
      const d = oldDate(x.date); if (!d) return;
      let r = getReg(d, target);
      if (!r) { r = { id: uid(), date: d, pointId: target, register: 0, check: 0 }; db.registers.push(r); }
      r.register = num(r.register) + num(x.cash); r.check = num(r.check) + num(x.check); stamp(r); cR++;
    });
    (book || []).forEach(x => {
      const d = oldDate(x.date); if (!d) return;
      db.cash.push(stamp({ id: uid(), date: d, pointId: target, cash: num(x.cash), added: num(x.added), expense: num(x.expense), note: '' }));
      cC++;
    });
    db.employees.forEach(e => { if (!e.pointId) e.pointId = target; });
    save(); render();
    alert(`Перенесено:\nточек — ${cP}\nсотрудников — ${cE}\nавансов — ${cA}\nпитания — ${cF}\nдней кассы — ${cR}\nзаписей налички — ${cC}`);
  };

  const needTarget = adv || daily || book || db.employees.some(e => !e.pointId);
  if (!db.points.length) addPoint('Точка 1');
  // По умолчанию — точка, где больше всего сотрудников
  const main = sortedPoints().map(p => ({ id: p.id, n: pointEmps(p.id, true).length })).sort((a, b) => b.n - a.n)[0].id;
  if (!needTarget) { finish(main); return; }
  save(); render();
  openSheet({
    title: 'К какой точке отнести?',
    fields: [
      { type: 'note', label: 'В старом приложении касса и наличка не были привязаны к точке. Выберите, к какой точке их отнести.' },
      { name: 'target', label: 'Точка', type: 'select', options: sortedPoints().map(p => ({ v: p.id, t: p.name })), value: main },
    ],
    saveLabel: 'Перенести',
    onSave: v => { setTimeout(() => finish(v.target), 0); },
  });
}

/* ================= Старт ================= */
purgeOld();
render();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
