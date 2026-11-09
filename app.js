'use strict';
/* Mi Agenda — todo vive en Google (Calendar, Tasks y Drive).
   La app no guarda datos propios: así Ale (ChatGPT), el celular y las
   personas con quienes compartes calendarios ven lo mismo. */

const CFG = window.APP_CONFIG || {};
const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/drive.file',
];
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Bogota';
const IDEAS_TITLE = 'Ideas';
const VOICE_FOLDER = 'Mi Agenda · Notas de voz';
const LOCALE = 'es-CO';

/* ---------- utilidades ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('agenda.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('agenda.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('agenda.' + k); } catch {} },
};
const ss = {
  get(k) { try { return sessionStorage.getItem('agenda.' + k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem('agenda.' + k, v); } catch {} },
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(9)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYMD = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };
const sameDay = (a, b) => ymd(a) === ymd(b);
const fmtTime = d => new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' }).format(d);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtDay = d => cap(new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' }).format(d));
const fmtShort = d => new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' }).format(d);
const fmtMonth = d => cap(new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(d));
const fmtStamp = d => new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(d);

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- estado ---------- */
const S = {
  token: null, exp: 0, user: store.get('user', null),
  calendars: [], hidden: new Set(store.get('hidden', [])),
  events: [], dueTasks: [],
  tab: store.get('tab', 'agenda'), view: store.get('view', 'semana'),
  anchor: startOfDay(new Date()),
  lists: [], listId: store.get('listId', null), tasks: [], showDone: false,
  ideasId: null, ideas: [],
  busy: 0, loadedAt: 0, error: null,
};

/* ---------- autenticación (OAuth de Google, flujo por redirección) ---------- */
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); }

function login(silent) {
  if (!CFG.clientId) return;
  const st = Math.random().toString(36).slice(2);
  ss.set('oauth_state', st);
  const p = new URLSearchParams({
    client_id: CFG.clientId, redirect_uri: redirectUri(), response_type: 'token',
    scope: SCOPES.join(' '), include_granted_scopes: 'true', state: st,
  });
  if (silent) p.set('prompt', 'none');
  if (S.user && S.user.email) p.set('login_hint', S.user.email);
  location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + p);
}

function readAuthFromHash() {
  if (!location.hash || location.hash.length < 2) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('access_token') && !p.has('error')) return;
  history.replaceState(null, '', location.pathname + location.search);
  const expected = ss.get('oauth_state');
  if (p.get('error')) { S.error = p.get('error') === 'access_denied' ? 'No se dio permiso a la cuenta.' : null; return; }
  if (expected && p.get('state') !== expected) { S.error = 'El inicio de sesión no coincidió. Intenta otra vez.'; return; }
  S.token = p.get('access_token');
  S.exp = Date.now() + (parseInt(p.get('expires_in') || '3600', 10) - 60) * 1000;
  store.set('auth', { t: S.token, e: S.exp });
  ss.set('silent_tried', '0');
}

function loadStoredAuth() {
  const a = store.get('auth', null);
  if (a && a.e > Date.now()) { S.token = a.t; S.exp = a.e; }
}

function logout() {
  if (S.token) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(S.token), { method: 'POST' }).catch(() => {});
  store.del('auth'); store.del('user'); S.token = null; S.user = null; render();
}

async function api(url, { method = 'GET', body, raw } = {}) {
  if (!S.token || Date.now() > S.exp) { login(true); throw new Error('reauth'); }
  const headers = { Authorization: 'Bearer ' + S.token };
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const r = await fetch(url, { method, headers, body: raw ? body : body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { store.del('auth'); S.token = null; login(true); throw new Error('reauth'); }
  if (!r.ok) {
    let m = 'Error ' + r.status;
    try { const j = await r.json(); m = (j.error && (j.error.message || j.error)) || m; } catch {}
    throw new Error(m);
  }
  if (r.status === 204) return null;
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

async function busy(fn) {
  S.busy++; renderBusy();
  try { return await fn(); }
  catch (e) { if (e.message !== 'reauth') toast(e.message || 'Algo falló'); throw e; }
  finally { S.busy--; renderBusy(); }
}

/* ---------- carga de datos ---------- */
function range() {
  if (S.view === 'mes') {
    const first = new Date(S.anchor.getFullYear(), S.anchor.getMonth(), 1);
    const start = startOfWeek(first);
    return { start, end: addDays(start, 42) };
  }
  const start = startOfWeek(S.anchor);
  return { start, end: addDays(start, 7) };
}

async function loadUser() {
  try { const u = await api('https://www.googleapis.com/oauth2/v3/userinfo'); S.user = { email: u.email, name: u.name, picture: u.picture }; store.set('user', S.user); } catch {}
}

async function loadCalendars() {
  const r = await api(CAL + '/users/me/calendarList?maxResults=250');
  S.calendars = (r.items || []).filter(c => !c.deleted)
    .map(c => ({ ...c, name: c.summaryOverride || c.summary }))
    .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.name.localeCompare(b.name, LOCALE));
}

async function loadEvents() {
  const { start, end } = range();
  const vis = S.calendars.filter(c => !S.hidden.has(c.id));
  const results = await Promise.all(vis.map(async c => {
    const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
    try {
      const r = await api(`${CAL}/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      return (r.items || []).filter(e => e.status !== 'cancelled').map(e => ({ ...e, cal: c }));
    } catch (e) { if (e.message === 'reauth') throw e; return []; }
  }));
  S.events = results.flat();
}

async function loadLists() {
  const r = await api(TASKS + '/users/@me/lists?maxResults=100');
  const lists = r.items || [];
  let ideas = lists.find(l => l.title === IDEAS_TITLE);
  if (!ideas) ideas = await api(TASKS + '/users/@me/lists', { method: 'POST', body: { title: IDEAS_TITLE } });
  S.ideasId = ideas.id;
  S.lists = lists.filter(l => l.id !== ideas.id);
  if (!S.listId || !S.lists.find(l => l.id === S.listId)) S.listId = S.lists[0] ? S.lists[0].id : null;
}

async function fetchTasks(listId, extra = {}) {
  const q = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100', ...extra });
  const out = [];
  let token;
  do {
    if (token) q.set('pageToken', token);
    const r = await api(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks?${q}`);
    out.push(...(r.items || []).map(t => ({ ...t, listId })));
    token = r.nextPageToken;
  } while (token && out.length < 500);
  return out;
}

async function loadDueTasks() {
  const { start, end } = range();
  const all = await Promise.all(S.lists.map(l => fetchTasks(l.id, { dueMin: start.toISOString(), dueMax: end.toISOString() }).catch(() => [])));
  S.dueTasks = all.flat().filter(t => t.due && !t.deleted);
}

async function loadTasks() { S.tasks = S.listId ? (await fetchTasks(S.listId)).filter(t => !t.deleted) : []; }
async function loadIdeas() { S.ideas = S.ideasId ? (await fetchTasks(S.ideasId, { showCompleted: 'false' })).filter(t => !t.deleted) : []; }

async function refresh(full) {
  await busy(async () => {
    if (full || !S.calendars.length) { await Promise.all([loadCalendars(), loadLists(), S.user ? null : loadUser()]); }
    if (S.tab === 'agenda') await Promise.all([loadEvents(), loadDueTasks()]);
    if (S.tab === 'tareas') await loadTasks();
    if (S.tab === 'ideas') await loadIdeas();
    S.loadedAt = Date.now();
  }).catch(() => {});
  render();
}

/* ---------- eventos: ayudas ---------- */
function evBounds(e) {
  if (e.start.date) return { s: parseYMD(e.start.date), e: parseYMD(e.end.date), allDay: true };
  return { s: new Date(e.start.dateTime), e: new Date(e.end.dateTime), allDay: false };
}
function eventsOn(day) {
  const ds = startOfDay(day), de = addDays(ds, 1);
  return S.events.filter(ev => {
    const b = evBounds(ev);
    if (b.s.getTime() === b.e.getTime()) return b.s >= ds && b.s < de;
    return b.s < de && b.e > ds;
  }).sort((a, b) => {
    const A = evBounds(a), B = evBounds(b);
    if (A.allDay !== B.allDay) return A.allDay ? -1 : 1;
    return A.s - B.s;
  });
}
const tasksOn = day => S.dueTasks.filter(t => t.due.slice(0, 10) === ymd(day));
const writable = c => c && (c.accessRole === 'owner' || c.accessRole === 'writer');
const calColor = c => (c && c.backgroundColor) || '#2f6b4f';
const defaultCal = () => S.calendars.find(c => c.id === store.get('defaultCal', null) && writable(c)) || S.calendars.find(c => c.primary) || S.calendars.find(writable);

/* ---------- render ---------- */
const app = document.getElementById('app');

function renderBusy() {
  const b = document.getElementById('refresh');
  if (b) b.classList.toggle('spin', S.busy > 0);
}

function render() {
  app.replaceChildren();
  document.querySelectorAll('nav.bottom, .fab').forEach(n => n.remove());
  if (!CFG.clientId) return app.append(setupScreen());
  if (!S.token) return app.append(loginScreen());

  const titles = { agenda: 'Agenda', tareas: 'Tareas', ideas: 'Ideas', ajustes: 'Ajustes' };
  app.append(h('header', { class: 'top' },
    h('h1', {}, titles[S.tab]),
    h('button', { class: 'icon-btn', id: 'refresh', 'aria-label': 'Actualizar', onclick: () => refresh(true) }, '↻'),
  ));
  renderBusy();

  if (S.tab === 'agenda') app.append(agendaView());
  if (S.tab === 'tareas') app.append(tasksView());
  if (S.tab === 'ideas') app.append(ideasView());
  if (S.tab === 'ajustes') app.append(settingsView());

  const tabs = [['agenda', '📅', 'Agenda'], ['tareas', '✓', 'Tareas'], ['ideas', '💡', 'Ideas'], ['ajustes', '⚙︎', 'Ajustes']];
  document.body.append(h('nav', { class: 'bottom' }, h('div', { class: 'in' },
    tabs.map(([id, ic, label]) => h('button', { class: S.tab === id ? 'on' : '', onclick: () => setTab(id) },
      h('span', { class: 'ic' }, ic), label)))));
  if (S.tab !== 'ajustes') document.body.append(h('button', { class: 'fab', 'aria-label': 'Agregar', onclick: quickAdd }, '+'));
}

function setTab(t) { S.tab = t; store.set('tab', t); render(); refresh(false); window.scrollTo(0, 0); }

function setupScreen() {
  return h('div', { class: 'login' },
    h('img', { src: 'icon.svg', alt: '' }),
    h('h1', {}, 'Falta un paso'),
    h('p', {}, 'Pega el ID de cliente de Google en config.js para activar la app. Las instrucciones están en el README.'));
}

function loginScreen() {
  return h('div', { class: 'login' },
    h('img', { src: 'icon.svg', alt: '' }),
    h('h1', {}, CFG.appName || 'Mi Agenda'),
    h('p', {}, 'Tus calendarios, tareas e ideas en un solo lugar. Todo queda guardado en tu cuenta de Google.'),
    S.error ? h('p', { style: 'color:var(--danger)' }, S.error) : null,
    h('button', { class: 'btn primary', onclick: () => login(false) }, 'Entrar con Google'));
}

/* Agenda */
function agendaView() {
  const wrap = h('div');
  const { start } = range();
  const label = S.view === 'mes' ? fmtMonth(S.anchor) : `${fmtShort(start)} – ${fmtShort(addDays(start, 6))}`;
  const step = n => { S.anchor = S.view === 'mes' ? new Date(S.anchor.getFullYear(), S.anchor.getMonth() + n, 1) : addDays(S.anchor, 7 * n); refresh(false); };
  wrap.append(h('div', { class: 'toolbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Anterior', onclick: () => step(-1) }, '‹'),
    h('div', { class: 'label' }, label),
    h('button', { class: 'icon-btn', 'aria-label': 'Siguiente', onclick: () => step(1) }, '›'),
    h('button', { class: 'pill', onclick: () => { S.anchor = startOfDay(new Date()); refresh(false); } }, 'Hoy'),
    h('div', { class: 'seg' },
      ['semana', 'mes'].map(v => h('button', { class: S.view === v ? 'on' : '', onclick: () => { S.view = v; store.set('view', v); refresh(false); } }, v === 'semana' ? 'Semana' : 'Mes'))),
  ));
  if (S.busy && !S.loadedAt) wrap.append(h('div', { class: 'loading-line' }));
  wrap.append(S.view === 'mes' ? monthGrid() : weekList());
  return wrap;
}

function weekList() {
  const { start } = range();
  const today = startOfDay(new Date());
  const box = h('div');
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const evs = eventsOn(d), tks = tasksOn(d);
    const card = h('div', { class: 'card' });
    evs.forEach(ev => card.append(eventItem(ev, d)));
    tks.forEach(t => card.append(taskItem(t, true)));
    if (!evs.length && !tks.length) card.append(h('div', { class: 'empty' }, 'Libre'));
    box.append(h('section', { class: 'day', id: 'd-' + ymd(d) },
      h('div', { class: 'day-h' }, h('b', {}, fmtDay(d)), sameDay(d, today) ? h('span', { class: 'badge' }, 'Hoy') : null),
      card));
  }
  setTimeout(() => { const el = document.getElementById('d-' + ymd(S.anchor)); if (el && !sameDay(S.anchor, startOfWeek(S.anchor))) el.scrollIntoView({ block: 'start' }); }, 0);
  return box;
}

function eventItem(ev, day) {
  const b = evBounds(ev);
  let time = 'Todo el día';
  if (!b.allDay) time = sameDay(b.s, day) ? fmtTime(b.s) : 'Sigue';
  const sub = [!b.allDay && sameDay(b.e, day) ? 'hasta ' + fmtTime(b.e) : null, ev.cal.name, ev.location].filter(Boolean).join(' · ');
  return h('button', { class: 'item', onclick: () => eventSheet(ev) },
    h('span', { class: 'time' }, time),
    h('span', { class: 'bar', style: `background:${calColor(ev.cal)}` }),
    h('span', { class: 'main' }, h('div', { class: 't' }, ev.summary || '(Sin título)'), h('div', { class: 's' }, sub)));
}

function monthGrid() {
  const { start } = range();
  const grid = h('div', { class: 'month' });
  ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'].forEach(w => grid.append(h('div', { class: 'wd' }, w)));
  const today = new Date();
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const evs = eventsOn(d), tks = tasksOn(d);
    const items = [...evs.map(e => ({ t: e.summary || '(Sin título)', c: calColor(e.cal) })), ...tks.map(t => ({ t: '✓ ' + t.title, c: 'var(--muted)' }))];
    const cell = h('button', {
      class: 'mcell' + (d.getMonth() !== S.anchor.getMonth() ? ' out' : '') + (sameDay(d, today) ? ' today' : ''),
      onclick: () => { S.anchor = d; S.view = 'semana'; store.set('view', 'semana'); refresh(false); },
    }, h('span', { class: 'n' }, d.getDate()));
    items.slice(0, 3).forEach(it => cell.append(h('span', { class: 'chip', style: `background:${it.c}` }, it.t)));
    if (items.length > 3) cell.append(h('span', { class: 'more' }, `+${items.length - 3}`));
    grid.append(cell);
  }
  return grid;
}

/* Tareas */
function taskItem(t, showList) {
  const done = t.status === 'completed';
  const list = S.lists.find(l => l.id === t.listId);
  const sub = [showList && list ? list.title : null, !showList && t.due ? 'Para el ' + fmtShort(parseYMD(t.due)) : null, t.notes ? t.notes.split('\n')[0] : null].filter(Boolean).join(' · ');
  return h('div', { class: 'item' + (done ? ' done' : '') },
    showList ? h('span', { class: 'time' }, 'Tarea') : null,
    h('button', { class: 'check' + (done ? ' on' : ''), 'aria-label': done ? 'Marcar pendiente' : 'Marcar hecha', onclick: () => toggleTask(t) }, done ? '✓' : ''),
    h('button', { class: 'main', style: 'border:0;background:none;text-align:left;padding:0', onclick: () => taskSheet(t) },
      h('div', { class: 't' }, t.title || '(Sin título)'), sub ? h('div', { class: 's' }, sub) : null));
}

function tasksView() {
  const wrap = h('div');
  wrap.append(h('div', { class: 'chips' },
    S.lists.map(l => h('button', { class: l.id === S.listId ? 'on' : '', onclick: () => { S.listId = l.id; store.set('listId', l.id); refresh(false); } }, l.title)),
    h('button', { onclick: newListSheet }, '+ Lista')));
  const title = h('input', { type: 'text', placeholder: 'Nueva tarea…', enterkeyhint: 'done' });
  const due = h('input', { type: 'date', 'aria-label': 'Fecha' });
  const add = async () => {
    if (!title.value.trim() || !S.listId) return;
    await busy(() => createTask(S.listId, { title: title.value.trim(), due: due.value })).catch(() => {});
    title.value = ''; due.value = ''; refresh(false);
  };
  title.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  wrap.append(h('div', { class: 'add-row' }, title, due, h('button', { class: 'btn primary', onclick: add }, 'Agregar')));

  const pending = S.tasks.filter(t => t.status !== 'completed').sort(byDueThenPos);
  const done = S.tasks.filter(t => t.status === 'completed');
  const card = h('div', { class: 'card' });
  pending.forEach(t => card.append(taskItem(t, false)));
  if (!pending.length) card.append(h('div', { class: 'empty' }, S.loadedAt ? 'Nada pendiente en esta lista.' : 'Cargando…'));
  wrap.append(card);
  if (done.length) {
    wrap.append(h('button', { class: 'pill', style: 'margin:14px 0 8px', onclick: () => { S.showDone = !S.showDone; render(); } },
      `${S.showDone ? 'Ocultar' : 'Ver'} hechas (${done.length})`));
    if (S.showDone) { const dc = h('div', { class: 'card' }); done.forEach(t => dc.append(taskItem(t, false))); wrap.append(dc); }
  }
  return wrap;
}
function byDueThenPos(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1; if (b.due) return 1;
  return (a.position || '').localeCompare(b.position || '');
}

async function createTask(listId, { title, notes, due }) {
  const body = { title };
  if (notes) body.notes = notes;
  if (due) body.due = due + 'T00:00:00.000Z';
  return api(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks`, { method: 'POST', body });
}

async function toggleTask(t) {
  const done = t.status === 'completed';
  await busy(() => api(`${TASKS}/lists/${encodeURIComponent(t.listId)}/tasks/${encodeURIComponent(t.id)}`,
    { method: 'PATCH', body: done ? { status: 'needsAction', completed: null } : { status: 'completed' } })).catch(() => {});
  refresh(false);
}

/* Ideas */
function ideasView() {
  const wrap = h('div');
  wrap.append(h('button', { class: 'mic', onclick: voiceSheet }, '🎙  Grabar nota de voz'));
  const txt = h('textarea', { placeholder: 'Escribe una idea…', rows: 3 });
  const save = async () => {
    const v = txt.value.trim(); if (!v) return;
    await busy(() => createIdea(v)).catch(() => {});
    txt.value = ''; refresh(false);
  };
  wrap.append(h('div', { class: 'field' }, txt), h('div', { class: 'actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: save }, 'Guardar idea')));
  wrap.append(h('div', { style: 'height:12px' }));
  if (!S.ideas.length) wrap.append(h('div', { class: 'empty' }, S.loadedAt ? 'Todavía no hay ideas.' : 'Cargando…'));
  const sorted = [...S.ideas].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  sorted.forEach(i => wrap.append(ideaCard(i)));
  return wrap;
}

function ideaParts(i) {
  const notes = i.notes || '';
  const m = notes.match(/https:\/\/drive\.google\.com\/\S+/);
  return { audio: m ? m[0] : null, text: notes.replace(/\n?🎙.*$/s, '').trim() };
}

function ideaCard(i) {
  const { audio, text } = ideaParts(i);
  return h('div', { class: 'idea' },
    h('div', { class: 't' }, i.title),
    text && text !== i.title ? h('div', { class: 'n' }, text) : null,
    h('div', { class: 'meta' },
      h('span', {}, i.updated ? fmtStamp(new Date(i.updated)) : ''),
      audio ? h('a', { href: audio, target: '_blank', rel: 'noopener' }, '▶︎ Escuchar') : null,
      h('span', { style: 'flex:1' }),
      h('button', { onclick: () => ideaToTask(i) }, '→ Tarea'),
      h('button', { onclick: () => eventSheet(null, { summary: i.title, description: i.notes || '' }) }, '→ Agenda'),
      h('button', { onclick: () => ideaSheet(i) }, 'Editar')));
}

function splitIdea(v) {
  const first = v.split('\n')[0].trim();
  const title = first.length > 80 ? first.slice(0, 77) + '…' : first;
  return { title, notes: v.length > title.length ? v : '' };
}
async function createIdea(text, audioLink) {
  const { title, notes } = splitIdea(text || 'Nota de voz ' + fmtStamp(new Date()));
  const full = [notes || (audioLink ? text : ''), audioLink ? '🎙 ' + audioLink : ''].filter(Boolean).join('\n');
  return api(`${TASKS}/lists/${encodeURIComponent(S.ideasId)}/tasks`, { method: 'POST', body: { title, notes: full || undefined } });
}

function ideaToTask(i) {
  if (!S.lists.length) return toast('Primero crea una lista de tareas.');
  const list = h('select', {}, S.lists.map(l => h('option', { value: l.id, selected: l.id === S.listId }, l.title)));
  const due = h('input', { type: 'date' });
  openSheet('Convertir en tarea', h('div', {},
    h('p', { style: 'margin-top:0' }, i.title),
    h('label', { class: 'field' }, h('span', {}, 'Lista'), list),
    h('label', { class: 'field' }, h('span', {}, 'Fecha (opcional)'), due),
    h('div', { class: 'actions' }, h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: async () => {
        await busy(async () => {
          await createTask(list.value, { title: i.title, notes: i.notes, due: due.value });
          await api(`${TASKS}/lists/${encodeURIComponent(S.ideasId)}/tasks/${encodeURIComponent(i.id)}`, { method: 'DELETE' });
        }).catch(() => {});
        closeSheet(); toast('Idea convertida en tarea'); refresh(false);
      } }, 'Convertir'))));
}

function ideaSheet(i) {
  const title = h('input', { type: 'text', value: i.title });
  const notes = h('textarea', { rows: 6 }, i.notes || '');
  openSheet('Idea', h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Título'), title),
    h('label', { class: 'field' }, h('span', {}, 'Detalle'), notes),
    h('div', { class: 'actions' },
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('¿Borrar esta idea?')) return;
        await busy(() => api(`${TASKS}/lists/${encodeURIComponent(S.ideasId)}/tasks/${encodeURIComponent(i.id)}`, { method: 'DELETE' })).catch(() => {});
        closeSheet(); refresh(false);
      } }, 'Borrar'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: async () => {
        await busy(() => api(`${TASKS}/lists/${encodeURIComponent(S.ideasId)}/tasks/${encodeURIComponent(i.id)}`, { method: 'PATCH', body: { title: title.value.trim() || i.title, notes: notes.value } })).catch(() => {});
        closeSheet(); refresh(false);
      } }, 'Guardar'))));
}

/* Notas de voz: graba audio, lo sube a tu Drive y transcribe en vivo si el navegador lo permite */
async function ensureVoiceFolder() {
  let id = store.get('voiceFolder', null);
  if (id) return id;
  const q = encodeURIComponent(`name='${VOICE_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const r = await api(`${DRIVE}/files?q=${q}&fields=files(id)`);
  id = r.files && r.files[0] ? r.files[0].id
    : (await api(`${DRIVE}/files?fields=id`, { method: 'POST', body: { name: VOICE_FOLDER, mimeType: 'application/vnd.google-apps.folder' } })).id;
  store.set('voiceFolder', id);
  return id;
}
async function uploadAudio(blob, name) {
  const folder = await ensureVoiceFolder();
  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify({ name, parents: [folder] })], { type: 'application/json' }));
  fd.append('file', blob, name);
  return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', body: fd, raw: true });
}

async function voiceSheet() {
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Este navegador no permite grabar audio.');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('No tengo permiso para usar el micrófono.'); }
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.start(1000);

  const transcript = h('textarea', { rows: 6, placeholder: 'La transcripción aparece aquí. También puedes escribir.' });
  let finalText = '', active = true, sr = null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    try {
      sr = new SR(); sr.lang = LOCALE; sr.continuous = true; sr.interimResults = true;
      sr.onresult = e => {
        let interim = '';
        for (let k = e.resultIndex; k < e.results.length; k++) {
          const t = e.results[k][0].transcript;
          if (e.results[k].isFinal) finalText += t.trim() + ' '; else interim += t;
        }
        transcript.value = (finalText + interim).trim();
      };
      sr.onend = () => { if (active) { try { sr.start(); } catch {} } };
      sr.start();
    } catch { sr = null; }
  }
  const t0 = Date.now();
  const clock = h('div', { class: 'rec-time' }, '0:00');
  const tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); clock.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`; }, 500);

  const stopAll = async () => {
    active = false; clearInterval(tick);
    if (sr) try { sr.stop(); } catch {}
    if (rec.state !== 'inactive') rec.stop();
    await stopped; stream.getTracks().forEach(t => t.stop());
  };

  const status = h('div', { class: 'inline', style: 'justify-content:center' }, h('span', { class: 'rec-dot' }), 'Grabando');
  const stopBtn = h('button', { class: 'btn primary grow' }, 'Detener');
  const saveAs = h('select', {}, h('option', { value: 'idea' }, 'Guardar como idea'), S.lists.length ? h('option', { value: 'tarea' }, 'Guardar como tarea') : null);
  const saveBtn = h('button', { class: 'btn primary', disabled: true }, 'Guardar');
  const discard = h('button', { class: 'btn danger' }, 'Descartar');

  discard.onclick = async () => { await stopAll(); closeSheet(); };
  stopBtn.onclick = async () => {
    await stopAll();
    status.replaceChildren('Grabación lista · revisa el texto');
    stopBtn.remove(); saveBtn.disabled = false;
  };
  saveBtn.onclick = async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Subiendo…';
    const ext = (rec.mimeType || mime).includes('mp4') ? 'm4a' : 'webm';
    const name = `Nota ${ymd(new Date())} ${hm(new Date()).replace(':', 'h')}.${ext}`;
    try {
      await busy(async () => {
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        const file = await uploadAudio(blob, name);
        const text = transcript.value.trim();
        if (saveAs.value === 'tarea') {
          const { title, notes } = splitIdea(text || 'Nota de voz ' + fmtStamp(new Date()));
          await createTask(S.listId || S.lists[0].id, { title, notes: [notes, '🎙 ' + file.webViewLink].filter(Boolean).join('\n') });
        } else await createIdea(text, file.webViewLink);
      });
      closeSheet(); toast('Nota de voz guardada'); refresh(false);
    } catch { saveBtn.disabled = false; saveBtn.textContent = 'Reintentar'; }
  };

  openSheet('Nota de voz', h('div', {},
    status, clock,
    !SR ? h('p', { class: 's', style: 'color:var(--muted);font-size:13px' }, 'Este navegador no transcribe en vivo: se guarda el audio y puedes escribir un resumen.') : null,
    h('label', { class: 'field' }, transcript),
    h('div', { class: 'field' }, saveAs),
    h('div', { class: 'actions' }, discard, stopBtn, saveBtn)), stopAll);
}

/* Ajustes */
function settingsView() {
  const wrap = h('div');
  wrap.append(h('div', { class: 'section' }, h('div', { class: 'note' },
    h('p', {}, h('b', {}, 'Ale y otras herramientas: '), 'esta app no guarda nada aparte. Todo queda en tu Google Calendar, Google Tasks y Drive, así que Ale (ChatGPT) y Google Calendar en el celular ven y editan lo mismo.'),
    h('p', {}, 'Las ideas viven en una lista de Google Tasks llamada «Ideas». Los audios, en la carpeta «' + VOICE_FOLDER + '» de tu Drive.'))));

  const def = defaultCal();
  const calCard = h('div', { class: 'card' });
  S.calendars.forEach(c => {
    const box = h('input', { type: 'checkbox', checked: !S.hidden.has(c.id), 'aria-label': 'Mostrar ' + c.name,
      onchange: e => { e.target.checked ? S.hidden.delete(c.id) : S.hidden.add(c.id); store.set('hidden', [...S.hidden]); } });
    const roles = { owner: 'Tuyo', writer: 'Puedes editar', reader: 'Solo ver', freeBusyReader: 'Ocupado/libre' };
    calCard.append(h('label', { class: 'cal-row' },
      h('span', { class: 'dot', style: `background:${calColor(c)}` }),
      h('span', { class: 'name' }, c.name, h('div', { class: 'role' }, roles[c.accessRole] || c.accessRole, def && def.id === c.id ? ' · predeterminado' : '')),
      box));
  });
  wrap.append(h('div', { class: 'section' }, h('h2', {}, 'Calendarios que se muestran'), calCard));

  const defSel = h('select', { onchange: e => { store.set('defaultCal', e.target.value); toast('Calendario predeterminado guardado'); render(); } },
    S.calendars.filter(writable).map(c => h('option', { value: c.id, selected: def && def.id === c.id }, c.name)));
  wrap.append(h('div', { class: 'section' }, h('h2', {}, 'Calendario para eventos nuevos'), defSel));

  const newName = h('input', { type: 'text', placeholder: 'Nombre del proyecto' });
  wrap.append(h('div', { class: 'section' }, h('h2', {}, 'Nuevo calendario de proyecto'),
    h('div', { class: 'add-row' }, newName, h('button', { class: 'btn primary', onclick: async () => {
      const v = newName.value.trim(); if (!v) return;
      await busy(() => api(CAL + '/calendars', { method: 'POST', body: { summary: v, timeZone: TZ } })).catch(() => {});
      newName.value = ''; toast('Calendario creado'); refresh(true);
    } }, 'Crear'))));

  wrap.append(shareSection());

  wrap.append(h('div', { class: 'section' }, h('h2', {}, 'En el celular'), h('div', { class: 'note' },
    h('p', {}, h('b', {}, 'iPhone: '), 'abre esta página en Safari → botón Compartir → «Agregar a inicio».'),
    h('p', {}, h('b', {}, 'Android: '), 'en Chrome → menú ⋮ → «Instalar app».'))));

  wrap.append(h('div', { class: 'section' }, h('h2', {}, 'Cuenta'),
    h('div', { class: 'card' }, h('div', { class: 'cal-row' },
      h('span', { class: 'name' }, S.user ? (S.user.name || '') : '', h('div', { class: 'role' }, S.user ? S.user.email : '')),
      h('button', { class: 'btn', onclick: logout }, 'Salir')))));
  return wrap;
}

function shareSection() {
  const owned = S.calendars.filter(c => c.accessRole === 'owner');
  const sec = h('div', { class: 'section' }, h('h2', {}, 'Compartir un calendario'));
  if (!owned.length) { sec.append(h('div', { class: 'empty' }, 'No tienes calendarios propios para compartir.')); return sec; }
  const cal = h('select', {}, owned.map(c => h('option', { value: c.id }, c.name)));
  const email = h('input', { type: 'email', placeholder: 'correo@ejemplo.com', autocomplete: 'email' });
  const role = h('select', {}, h('option', { value: 'writer' }, 'Puede agregar y editar'), h('option', { value: 'reader' }, 'Solo puede ver'));
  const list = h('div', { class: 'card', style: 'margin-top:10px' });
  const roles = { owner: 'Dueño', writer: 'Edita', reader: 'Ve', freeBusyReader: 'Ocupado/libre' };

  const loadAcl = async () => {
    list.replaceChildren(h('div', { class: 'empty' }, 'Cargando personas…'));
    try {
      const r = await api(`${CAL}/calendars/${encodeURIComponent(cal.value)}/acl`);
      const rows = (r.items || []).filter(a => a.scope && a.scope.type === 'user' && a.scope.value !== (S.user && S.user.email) && a.scope.value !== cal.value);
      list.replaceChildren();
      if (!rows.length) list.append(h('div', { class: 'empty' }, 'Nadie más tiene acceso a este calendario.'));
      rows.forEach(a => list.append(h('div', { class: 'cal-row' },
        h('span', { class: 'name' }, a.scope.value, h('div', { class: 'role' }, roles[a.role] || a.role)),
        a.role !== 'owner' ? h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`¿Quitarle el acceso a ${a.scope.value}?`)) return;
          await busy(() => api(`${CAL}/calendars/${encodeURIComponent(cal.value)}/acl/${encodeURIComponent(a.id)}`, { method: 'DELETE' })).catch(() => {});
          loadAcl();
        } }, 'Quitar') : null)));
    } catch (e) { list.replaceChildren(h('div', { class: 'empty' }, 'No pude leer quién tiene acceso.')); }
  };
  cal.onchange = loadAcl;
  setTimeout(loadAcl, 0);

  sec.append(
    h('label', { class: 'field' }, h('span', {}, 'Calendario'), cal),
    h('label', { class: 'field' }, h('span', {}, 'Persona'), email),
    h('label', { class: 'field' }, h('span', {}, 'Permiso'), role),
    h('div', { class: 'actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: async () => {
      const v = email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(v)) return toast('Escribe un correo válido');
      await busy(() => api(`${CAL}/calendars/${encodeURIComponent(cal.value)}/acl?sendNotifications=true`,
        { method: 'POST', body: { role: role.value, scope: { type: 'user', value: v } } })).catch(() => {});
      email.value = ''; toast('Calendario compartido. Google le avisa por correo.'); loadAcl();
    } }, 'Compartir')),
    list);
  return sec;
}

/* ---------- hojas (formularios) ---------- */
let sheetCleanup = null;
function openSheet(title, content, onClose) {
  closeSheet();
  sheetCleanup = onClose || null;
  const scrim = h('div', { class: 'scrim', id: 'scrim', onclick: e => { if (e.target === scrim) closeSheet(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-h' }, h('h3', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Cerrar', onclick: closeSheet }, '✕')),
      content));
  document.body.append(scrim);
  const first = scrim.querySelector('input[type=text], textarea');
  if (first && !('ontouchstart' in window)) first.focus();
}
function closeSheet() {
  const s = document.getElementById('scrim');
  if (s) s.remove();
  if (sheetCleanup) { const f = sheetCleanup; sheetCleanup = null; f(); }
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function quickAdd() {
  if (S.tab === 'tareas') return taskSheet(null);
  if (S.tab === 'ideas') return voiceSheet();
  eventSheet(null);
}

function eventSheet(ev, prefill = {}) {
  const editable = !ev || writable(ev.cal);
  const cals = S.calendars.filter(writable);
  if (!cals.length) return toast('No tienes calendarios donde puedas escribir.');
  const b = ev ? evBounds(ev) : null;
  const base = b ? b.s : (() => { const d = new Date(S.anchor); const n = new Date(); d.setHours(n.getHours() + 1, 0, 0, 0); return d; })();
  const endBase = b ? (b.allDay ? addDays(b.e, -1) : b.e) : new Date(base.getTime() + 3600e3);

  const calSel = h('select', { disabled: !editable }, (ev && !writable(ev.cal) ? [ev.cal] : cals).map(c => h('option', { value: c.id, selected: ev ? c.id === ev.cal.id : c.id === defaultCal().id }, c.name)));
  const title = h('input', { type: 'text', value: (ev ? ev.summary : prefill.summary) || '', placeholder: 'Título', disabled: !editable });
  const allDay = h('input', { type: 'checkbox', checked: b ? b.allDay : false, disabled: !editable });
  const sDate = h('input', { type: 'date', value: ymd(base), disabled: !editable });
  const sTime = h('input', { type: 'time', value: hm(base), disabled: !editable });
  const eDate = h('input', { type: 'date', value: ymd(endBase), disabled: !editable });
  const eTime = h('input', { type: 'time', value: hm(endBase), disabled: !editable });
  const loc = h('input', { type: 'text', value: (ev && ev.location) || '', placeholder: 'Lugar o enlace', disabled: !editable });
  const desc = h('textarea', { rows: 3, placeholder: 'Notas', disabled: !editable }, (ev ? ev.description : prefill.description) || '');
  const guests = h('input', { type: 'text', value: ev && ev.attendees ? ev.attendees.filter(a => !a.self).map(a => a.email).join(', ') : '', placeholder: 'correo1, correo2', disabled: !editable });
  const syncTimes = () => { sTime.style.display = eTime.style.display = allDay.checked ? 'none' : ''; };
  allDay.onchange = syncTimes; syncTimes();
  sDate.onchange = () => { if (eDate.value < sDate.value) eDate.value = sDate.value; };

  const save = async () => {
    if (!title.value.trim()) return toast('Ponle un título');
    const body = { summary: title.value.trim(), location: loc.value.trim(), description: desc.value };
    if (allDay.checked) {
      body.start = { date: sDate.value }; body.end = { date: ymd(addDays(parseYMD(eDate.value || sDate.value), 1)) };
    } else {
      const st = `${sDate.value}T${sTime.value}:00`, en = `${eDate.value || sDate.value}T${eTime.value}:00`;
      if (en <= st) return toast('La hora de fin debe ser después del inicio');
      body.start = { dateTime: st, timeZone: TZ }; body.end = { dateTime: en, timeZone: TZ };
    }
    const emails = guests.value.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    const prev = ev && ev.attendees ? ev.attendees : [];
    if (emails.length || prev.length) body.attendees = [...prev.filter(a => a.self), ...emails.map(e => prev.find(a => a.email === e) || { email: e })];
    const notify = emails.length ? '?sendUpdates=all' : '';
    await busy(async () => {
      if (ev) {
        await api(`${CAL}/calendars/${encodeURIComponent(ev.cal.id)}/events/${encodeURIComponent(ev.id)}${notify}`, { method: 'PATCH', body });
        if (calSel.value !== ev.cal.id) await api(`${CAL}/calendars/${encodeURIComponent(ev.cal.id)}/events/${encodeURIComponent(ev.id)}/move?destination=${encodeURIComponent(calSel.value)}`, { method: 'POST' });
      } else {
        await api(`${CAL}/calendars/${encodeURIComponent(calSel.value)}/events${notify}`, { method: 'POST', body });
      }
    }).then(() => { closeSheet(); toast(ev ? 'Evento actualizado' : 'Evento creado'); refresh(false); }).catch(() => {});
  };
  const del = async () => {
    if (!confirm('¿Borrar este evento? Se borra también de Google Calendar.')) return;
    await busy(() => api(`${CAL}/calendars/${encodeURIComponent(ev.cal.id)}/events/${encodeURIComponent(ev.id)}`, { method: 'DELETE' }))
      .then(() => { closeSheet(); toast('Evento borrado'); refresh(false); }).catch(() => {});
  };

  openSheet(ev ? (editable ? 'Editar evento' : 'Evento') : 'Nuevo evento', h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Calendario'), calSel),
    h('label', { class: 'field' }, title),
    h('label', { class: 'inline' }, allDay, 'Todo el día'),
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, 'Empieza'), sDate), h('label', { class: 'field' }, h('span', {}, ' '), sTime)),
    h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', {}, 'Termina'), eDate), h('label', { class: 'field' }, h('span', {}, ' '), eTime)),
    h('label', { class: 'field' }, h('span', {}, 'Lugar'), loc),
    h('label', { class: 'field' }, h('span', {}, 'Invitados (reciben correo de Google)'), guests),
    h('label', { class: 'field' }, h('span', {}, 'Notas'), desc),
    ev && ev.recurringEventId ? h('p', { style: 'font-size:13px;color:var(--muted)' }, 'Es un evento repetido: los cambios aplican solo a este día.') : null,
    ev && ev.htmlLink ? h('p', { style: 'font-size:13px' }, h('a', { href: ev.htmlLink, target: '_blank', rel: 'noopener' }, 'Abrir en Google Calendar')) : null,
    editable ? h('div', { class: 'actions' },
      ev ? h('button', { class: 'btn danger', onclick: del }, 'Borrar') : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: save }, ev ? 'Guardar' : 'Crear')) : null));
}

function taskSheet(t) {
  if (!S.lists.length) return toast('Crea primero una lista de tareas.');
  const list = h('select', { disabled: !!t }, S.lists.map(l => h('option', { value: l.id, selected: t ? l.id === t.listId : l.id === S.listId }, l.title)));
  const title = h('input', { type: 'text', value: t ? t.title : '', placeholder: '¿Qué hay que hacer?' });
  const due = h('input', { type: 'date', value: t && t.due ? t.due.slice(0, 10) : '' });
  const notes = h('textarea', { rows: 3, placeholder: 'Notas' }, t ? t.notes || '' : '');
  const save = async () => {
    if (!title.value.trim()) return toast('Escribe la tarea');
    await busy(async () => {
      if (t) await api(`${TASKS}/lists/${encodeURIComponent(t.listId)}/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH',
        body: { title: title.value.trim(), notes: notes.value, due: due.value ? due.value + 'T00:00:00.000Z' : null } });
      else await createTask(list.value, { title: title.value.trim(), notes: notes.value, due: due.value });
    }).then(() => { closeSheet(); toast(t ? 'Tarea actualizada' : 'Tarea creada'); refresh(false); }).catch(() => {});
  };
  openSheet(t ? 'Tarea' : 'Nueva tarea', h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Lista'), list),
    h('label', { class: 'field' }, title),
    h('label', { class: 'field' }, h('span', {}, 'Fecha'), due),
    h('label', { class: 'field' }, h('span', {}, 'Notas'), notes),
    h('div', { class: 'actions' },
      t ? h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm('¿Borrar esta tarea?')) return;
        await busy(() => api(`${TASKS}/lists/${encodeURIComponent(t.listId)}/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' }))
          .then(() => { closeSheet(); refresh(false); }).catch(() => {});
      } }, 'Borrar') : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onclick: save }, t ? 'Guardar' : 'Crear'))));
}

function newListSheet() {
  const name = h('input', { type: 'text', placeholder: 'Ej.: Los Montañeritos, Casa, Compras' });
  openSheet('Nueva lista de tareas', h('div', {},
    h('label', { class: 'field' }, name),
    h('div', { class: 'actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: async () => {
      const v = name.value.trim(); if (!v) return;
      await busy(async () => { const l = await api(TASKS + '/users/@me/lists', { method: 'POST', body: { title: v } }); S.listId = l.id; store.set('listId', l.id); })
        .then(() => { closeSheet(); refresh(true); }).catch(() => {});
    } }, 'Crear'))));
}

/* ---------- arranque ---------- */
readAuthFromHash();
if (!S.token) loadStoredAuth();
render();
if (S.token) refresh(true);
else if (CFG.clientId && S.user && !S.error && ss.get('silent_tried') !== '1') { ss.set('silent_tried', '1'); login(true); }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.token) return;
  if (Date.now() > S.exp) return login(true);
  if (Date.now() - S.loadedAt > 60e3 && !document.getElementById('scrim')) refresh(false);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
