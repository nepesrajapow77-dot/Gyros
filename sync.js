// Синхронизация с облаком Firebase.
// Бухгалтер: локальные записи → облако, плюс правки с других телефонов → сюда.
// Начальник: только читает облако.
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const cfg = window.FIREBASE_CONFIG;
const App = window.App;
const LAST_USER = App.VIEWER ? 'buh.view.lastUser' : 'buh.lastUser';

const ERRORS = {
  'auth/invalid-credential': 'Неверная почта или пароль',
  'auth/wrong-password': 'Неверная почта или пароль',
  'auth/user-not-found': 'Неверная почта или пароль',
  'auth/invalid-email': 'Неправильная почта',
  'auth/too-many-requests': 'Слишком много попыток. Подождите пару минут',
  'auth/network-request-failed': 'Нет интернета',
  'permission-denied': App.VIEWER ? 'Нет доступа. Попросите бухгалтера добавить вашу почту' : 'Нет прав на запись в облако',
};
const msg = e => ERRORS[e && e.code] || (e && e.message) || 'Ошибка';

let A, F, auth, fs, user = null, unsubs = [];
let pushTimer = null, pushing = false, again = false, retryTimer = null;

function lastUser() { try { return localStorage.getItem(LAST_USER); } catch (e) { return null; } }
function setLastUser(v) { try { v ? localStorage.setItem(LAST_USER, v) : localStorage.removeItem(LAST_USER); } catch (e) {} }

async function start() {
  try {
    [, A, F] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-auth.js'),
      import(SDK + 'firebase-firestore.js'),
    ]);
  } catch (e) {
    // Нет интернета при запуске: работаем с тем, что сохранено на телефоне
    App.setSync({ checking: false, user: lastUser(), status: 'offline' });
    addEventListener('online', () => location.reload(), { once: true });
    return;
  }
  const { initializeApp } = await import(SDK + 'firebase-app.js');
  const app = initializeApp(cfg);
  auth = A.getAuth(app);
  fs = F.getFirestore(app);

  A.onAuthStateChanged(auth, u => {
    stopListening();
    user = u ? u.email : null;
    setLastUser(user);
    App.setSync({ checking: false, user, status: user ? 'busy' : 'off', error: '' });
    if (user) { listen(); schedulePush(); }
  });
  addEventListener('online', () => { if (user) { App.setSync({ status: 'busy' }); schedulePush(); } });
  addEventListener('offline', () => { if (user) App.setSync({ status: 'offline' }); });
}

// Слушаем только новые записи (новее последней полученной) — так меньше чтений
function listen() {
  const d = App.db;
  App.COLS.forEach(col => {
    const since = d.sync.pull[col] || 0;
    const q = F.query(F.collection(fs, 'biz', 'main', col), F.where('updatedAt', '>', since));
    unsubs.push(F.onSnapshot(q, snap => {
      const docs = [];
      snap.docChanges().forEach(ch => { if (ch.type !== 'removed') docs.push(ch.doc.data()); });
      if (docs.length) {
        App.applyRemote(col, docs);
        const max = Math.max(App.db.sync.pull[col] || 0, ...docs.map(x => x.updatedAt || 0));
        App.db.sync.pull[col] = max;
        App.saveSyncMeta();
      }
      if (!snap.metadata.fromCache && !pushing) App.setSync({ status: navigator.onLine ? 'ok' : 'offline', lastOk: Date.now(), error: '' });
    }, err => App.setSync({ status: 'error', error: msg(err) })));
  });
}
function stopListening() { unsubs.forEach(u => u()); unsubs = []; }

function schedulePush() {
  if (App.VIEWER || !user) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 700);
}

// Отправляем всё, что изменилось после последней отправки
async function push() {
  if (App.VIEWER || !user) return;
  if (pushing) { again = true; return; }
  const d = App.db;
  const items = [];
  App.COLS.forEach(col => d[col].forEach(r => {
    if ((r.updatedAt || 0) > (r.syncedAt || 0)) items.push({ col, rec: r, data: clean(r) });
  }));
  d.deleted.forEach(t => {
    if (!t.synced) items.push({ col: t.col, tomb: t, data: { id: t.id, deleted: true, updatedAt: t.updatedAt } });
  });
  if (!items.length) { App.setSync({ status: navigator.onLine ? 'ok' : 'offline', lastOk: Date.now() }); return; }

  pushing = true;
  App.setSync({ status: navigator.onLine ? 'busy' : 'offline' });
  try {
    for (let i = 0; i < items.length; i += 400) {
      const batch = F.writeBatch(fs);
      items.slice(i, i + 400).forEach(it => batch.set(F.doc(fs, 'biz', 'main', it.col, it.data.id), it.data));
      await batch.commit();
    }
    // Отмечаем отправленное (только если запись не поменяли, пока шла отправка)
    items.forEach(it => {
      if (it.tomb) it.tomb.synced = true;
      else if (it.rec.updatedAt === it.data.updatedAt) it.rec.syncedAt = it.data.updatedAt;
    });
    // Старые пометки об удалении больше не нужны
    const monthAgo = Date.now() - 30 * 864e5;
    d.deleted = d.deleted.filter(t => !t.synced || t.updatedAt > monthAgo);
    App.saveSyncMeta();
    App.setSync({ status: 'ok', lastOk: Date.now(), error: '' });
  } catch (e) {
    App.setSync({ status: e.code === 'permission-denied' ? 'error' : 'offline', error: msg(e) });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(schedulePush, 30000);
  } finally {
    pushing = false;
    if (again) { again = false; schedulePush(); }
  }
}

function clean(r) {
  const o = JSON.parse(JSON.stringify(r));
  delete o.syncedAt;
  return o;
}

async function signIn(email, password) {
  if (!auth) { App.toast('Нет связи с облаком'); return; }
  try {
    App.setSync({ error: '' });
    await A.signInWithEmailAndPassword(auth, email, password);
    App.toast('Вход выполнен');
  } catch (e) {
    App.setSync({ error: msg(e) });
  }
}

async function signOut() {
  stopListening();
  setLastUser(null);
  if (auth) await A.signOut(auth).catch(() => {});
  user = null;
  // У начальника после выхода на телефоне ничего не остаётся
  if (App.VIEWER) App.resetLocal();
  App.setSync({ user: null, status: 'off', error: '' });
}

window.Sync = { schedulePush, signIn, signOut };
if (cfg) start();
