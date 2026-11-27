'use strict';
/* ================= Данные ================= */
const VIEWER = !!window.VIEWER;   // режим начальника: только просмотр
const KEY = VIEWER ? 'buh.view.v1' : 'buh.v1', UIKEY = VIEWER ? 'buh.view.ui' : 'buh.ui';
const COLS = ['points', 'employees', 'registers', 'food', 'advances', 'cash', 'photos'];
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
function emptyDb() { return { version: 2, points: [], employees: [], registers: [], food: [], advances: [], cash: [], photos: [], deleted: [], lastBackup: 0, sync: { lastPush: 0, pull: {} } }; }
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
function removeRec(col, rec) {
  db[col] = db[col].filter(x => x !== rec);
  db.deleted.push({ col, id: rec.id, updatedAt: Date.now() });
}

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
  photoSynced: p => p.deleted ? PDB.del(p.id) : PDB.put(Object.assign({}, p, { synced: true })),
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
  $('#main').innerHTML = ({ day: viewDay, cash: viewCash, pay: viewPay, more: viewMore })[ui.tab]();
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
  const dayPhotos = db.photos.filter(p => p.date === d && p.pointId === pid && !p.cashId);
  const people = peopleOpts(pid, false);
  const foodPeople = peopleOpts(pid, true);
  const noPeople = !people.length ? `<p class="status muted">У этой точки нет сотрудников. Добавьте их во вкладке «Ещё».</p>` : '';
  const val = v => v === '' || v == null ? '' : v;
  const t = cashTimeline();

  return `
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
    ${dayCash.map(c => `<button class="item" ${VIEWER ? '' : `data-act="editCash" data-id="${c.id}"`}><span>${esc(c.note || 'Запись')}</span><span class="num">${cashLine(c)}</span></button>` + photoGrid(cashPhotos(c.id))).join('')}
    ${dayAdv.length ? `<div class="item"><span>Аванс<span class="sub">${dayAdv.map(a => esc(empName(a.employeeId))).join(', ')}</span></span><span class="num">− ${money(sum(dayAdv, 'amount'))}</span></div>` : ''}
    ${t.days[d] && t.days[d].salary ? `<div class="item"><span>Зарплата<span class="sub">${t.days[d].pays.map(p => esc(p.e.name)).join(', ')}</span></span><span class="num">− ${money(t.days[d].salary)}</span></div>` : ''}
    ${VIEWER ? (dayCash.length || dayAdv.length ? '' : '<p class="sub">Записей нет</p>') : `<form data-form="cash" class="stack" style="margin-top:10px">
      <div class="grid3">
        <label class="fld"><span>Наличные</span><input name="cash" inputmode="decimal" placeholder="0" autocomplete="off"></label>
        <label class="fld"><span>Добавлено</span><input name="added" inputmode="decimal" placeholder="0" autocomplete="off"></label>
        <label class="fld"><span>Расход</span><input name="expense" inputmode="decimal" placeholder="0" autocomplete="off"></label>
      </div>
      <input name="note" placeholder="Комментарий (на что расход)" autocomplete="off">
      <label class="filebtn photobtn">📷 Фото чека<span id="cashPhotoCount"></span>
        <input type="file" accept="image/*" multiple data-change="cashFormPhotos"></label>
      <button class="primary">Добавить</button>
    </form>`}
    <div class="big"><span class="muted">Остаток на конец дня</span><b class="${balanceAt(d, t) < 0 ? 'neg' : ''}">${money(balanceAt(d, t))}</b></div>
  </section>`;
  return dayCard + cashMonth(t, m, issues);
}
function cashMonth(t, m, issues) {
  const before = balanceAt(addDays(m + '-01', -1), t);
  let inc = 0, exp = 0, adv = 0, sal = 0;
  t.dates.filter(d => d.startsWith(m)).forEach(d => { const x = t.days[d]; inc += x.cash + x.added; exp += x.expense; adv += x.advance; sal += x.salary; });
  const end = before + inc - exp - adv - sal;
  const mdates = [...new Set([...t.dates, ...Object.keys(issues)])].filter(d => d.startsWith(m)).sort().reverse();

  const summary = `<section class="card"><h2>Итог за ${fmtMonth(m).toLowerCase()}</h2>
    <div class="stats">
      <div class="stat"><small>На начало</small><b>${money(before)}</b></div>
      <div class="stat"><small>Приход</small><b>${money(inc)}</b></div>
      <div class="stat"><small>Расход</small><b>${money(exp)}</b></div>
      <div class="stat"><small>Аванс</small><b>${money(adv)}</b></div>
      ${sal ? `<div class="stat"><small>Зарплата</small><b>${money(sal)}</b></div>` : ''}
    </div>
    <div class="big"><span class="muted">Остаток на конец</span><b class="${end < 0 ? 'neg' : ''}">${money(end)}</b></div></section>`;

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

/* ---------- Зарплата ---------- */
function viewPay() {
  if (!db.points.length) return emptyState();
  const m = ui.month, pf = ui.payPoint;
  const inM = x => x.date.startsWith(m);
  const foodM = db.food.filter(inM), advM = db.advances.filter(inM);
  const hasRecs = e => foodM.some(f => f.employeeId === e.id) || advM.some(a => a.employeeId === e.id) || (e.paid && e.paid[m]);
  const emps = db.employees.filter(e => (pf === 'all' || e.pointId === pf) &&
      (hasRecs(e) || (!e.archived && workDays(e, m).days > 0)))
    .sort((a, b) => pointName(a.pointId).localeCompare(pointName(b.pointId), 'ru') || byName(a, b));

  let tS = 0, tF = 0, tA = 0, tP = 0;
  let lastPoint = null;
  const cards = emps.map(e => {
    const fl = foodM.filter(f => f.employeeId === e.id), al = advM.filter(a => a.employeeId === e.id);
    const ac = accrued(e, m), s = Math.round(ac.amount), f = sum(fl, 'amount'), a = sum(al, 'amount'), pay = s - f - a;
    const paid = e.paid && e.paid[m];
    tS += s; tF += f; tA += a; if (paid) tP += num(paid.amount);
    const hist = [...fl.map(x => ({ d: x.date, t: 'Питание', v: x.amount })), ...al.map(x => ({ d: x.date, t: 'Аванс', v: x.amount }))]
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
      <div class="stat"><small>Всего к выдаче</small><b>${money(tS - tF - tA)}</b></div>
      <div class="stat"><small>Уже выдано</small><b>${money(tP)}</b></div>
      <div class="stat"><small>Выдано сотрудникам</small><b>${emps.filter(e => e.paid && e.paid[m]).length} из ${emps.length}</b></div>
    </div></section>` +
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

  <section class="card"><h2>Резервная копия</h2>
    <p class="sub">${syncState.user ? 'Данные хранятся в облаке, но копия на всякий случай не помешает.' : 'Данные хранятся только на этом телефоне. Делайте копию раз в неделю и отправляйте её себе, например в Telegram или на Диск.'}</p>
    <p class="sub" style="margin:6px 0 10px">Последняя копия: <b>${lb}</b></p>
    <div class="stack">
      <button class="primary" data-act="export">Сохранить копию</button>
      <label class="filebtn" style="min-height:44px;border-radius:10px;background:var(--line)">Восстановить из копии
        <input type="file" accept=".json,application/json" data-change="importBackup"></label>
    </div>
  </section>

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

function cloudCard() {
  if (!syncState.enabled) return `<section class="card"><h2>Облако</h2>
    <p class="sub">Облако ещё не подключено. После подключения начальник сможет смотреть отчёты со своего телефона.</p></section>`;
  if (!syncState.user) return `<section class="card"><h2>Облако</h2>
    <p class="sub" style="margin-bottom:10px">Войдите, чтобы данные отправлялись в облако и начальник их видел.</p>
    <form data-form="login" class="stack">
      <label class="fld"><span>Почта</span><input name="email" type="email" autocomplete="username" required></label>
      <label class="fld"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Войти</button>
      ${syncState.error ? `<p class="status bad">${esc(syncState.error)}</p>` : ''}
    </form></section>`;
  return `<section class="card"><h2>Облако <span class="badge ok">подключено</span></h2>
    <p>Вход: <b>${esc(syncState.user)}</b></p>
    <p class="sub" style="margin:6px 0 10px">Все записи отправляются в облако сами. Без интернета — отправятся, когда связь появится.
    Ссылка для начальника: <b>${esc(location.href.replace(/[^/]*$/, ''))}boss.html</b></p>
    <div class="stack"><button data-act="shareBoss">Отправить ссылку начальнику</button>
    <button class="ghost" data-act="logout">Выйти из облака</button></div></section>`;
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
  delete photoUrl[p.id];
  PDB.put({ id: p.id, data: null, deleted: true, synced: false }).catch(() => {});
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
    fields.forEach(fd => { if (fd.name) { const i = f.elements[fd.name]; v[fd.name] = fd.type === 'check' ? i.checked : i.value.trim(); } });
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
  const used = !isNew && (db.food.some(f => f.employeeId === e.id) || db.advances.some(a => a.employeeId === e.id));
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
    db.food.some(f => f.pointId === p.id) || db.advances.some(a => a.pointId === p.id) || db.cash.some(c => c.pointId === p.id));
  openSheet({
    title: isNew ? 'Новая точка' : 'Точка',
    fields: [
      { name: 'name', label: 'Название или адрес', value: p.name, placeholder: 'Кафе на Ленина' },
      ...(used ? [{ type: 'note', label: 'У точки есть сотрудники или записи, поэтому её нельзя удалить.' }] : []),
    ],
    onSave: v => {
      if (!v.name) { toast('Введите название'); return false; }
      p.name = v.name;
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
  editCash: t => {
    const c = db.cash.find(x => x.id === t.dataset.id); if (!c) return;
    openSheet({
      title: 'Наличка · ' + fmtDay(c.date),
      fields: [
        { name: 'cash', label: 'Наличные', type: 'number', value: c.cash },
        { name: 'added', label: 'Добавлено', type: 'number', value: c.added },
        { name: 'expense', label: 'Расход', type: 'number', value: c.expense },
        { name: 'note', label: 'Комментарий', value: c.note },
        { name: 'date', label: 'Дата', type: 'date', value: c.date },
        { type: 'html', html: `<div class="fld"><span>Фото чека</span><div id="sheetPhotos">${photoGrid(cashPhotos(c.id)) || '<p class="sub">Нет фото</p>'}</div>
          <label class="filebtn photobtn">📷 Добавить фото<input type="file" accept="image/*" multiple data-change="cashPhotos" data-id="${c.id}"></label></div>` },
      ],
      onSave: v => {
        Object.assign(c, { cash: num(v.cash), added: num(v.added), expense: num(v.expense), note: v.note, date: v.date || c.date }); stamp(c);
        cashPhotos(c.id).forEach(p => { if (p.date !== c.date) { p.date = c.date; stamp(p); } });
      },
      onDelete: () => { cashPhotos(c.id).forEach(removePhoto); removeRec('cash', c); },
    });
    hydratePhotos();
  },
  setDate: t => { ui.date = t.dataset.date; render(); scrollTo(0, 0); },
  paySheet: t => {
    const e = emp(t.dataset.id); if (!e) return;
    const m = ui.month, cur = e.paid && e.paid[m], inM = x => x.date.startsWith(m) && x.employeeId === e.id;
    const calc = Math.round(accrued(e, m).amount) - sum(db.food.filter(inM), 'amount') - sum(db.advances.filter(inM), 'amount');
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
const EDIT_ACTS = new Set(['editFood', 'editAdv', 'editCash', 'addPoint', 'editPoint', 'addEmp', 'editEmp', 'wipe', 'export', 'delPhoto', 'paySheet']);

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

const forms = {
  login: f => {
    if (!window.Sync) { toast('Облако ещё загружается, попробуйте через секунду'); return; }
    const btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Входим…';
    window.Sync.signIn(f.elements.email.value.trim(), f.elements.password.value)
      .finally(() => { btn.disabled = false; btn.textContent = 'Войти'; });
  },
  food: f => addAmount(f, 'food'),
  adv: f => addAmount(f, 'adv'),
  cash: f => {
    const v = k => num(f.elements[k].value);
    const files = pendingCashFiles; pendingCashFiles = [];
    if (!v('cash') && !v('added') && !v('expense') && !files.length) { toast('Введите хотя бы одну сумму'); return; }
    const c = stamp({ id: uid(), date: ui.date, pointId: '', cash: v('cash'), added: v('added'), expense: v('expense'), note: f.elements.note.value.trim() });
    db.cash.push(c);
    save(); render(); toast('Добавлено');
    if (files.length) addPhotos(files, { date: c.date, pointId: c.pointId, cashId: c.id });
  },
};

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

function exportDb() {
  db.lastBackup = Date.now(); save();
  const name = 'kassa-' + today() + '.json';
  const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  render();
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
render();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
