import {
  init as vkInit,
  getFriends as vkGetFriends,
  copyText as vkCopyText,
  downloadFile as vkDownloadFile,
  storageGet as vkStorageGet,
  storageSet as vkStorageSet,
  getUserAuthToken as vkGetUserAuthToken,
  getLaunchParams as vkGetLaunchParams,
  uploadDoc as vkUploadDoc,
  sendMessage as vkSendMessage,
  isVK,
  isNativeClient
} from './vk.js';

const STORAGE_KEY = 'vkshifts_v1';      // localStorage (быстро, работает и без ВК)
const VK_STORAGE_KEY = 'vkshifts_state'; // VK Storage (привязан к пользователю, а не к устройству)
const STORAGE_SYNC_DELAY = 1500;         // задержка записи в VK Storage после изменений

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let currentTab = 'schedule';
let state = { employees: [], stores: [], shifts: [], weekOffset: 0, updatedAt: 0 };
let syncTimer = null;
let lastPushedValue = null;

/* ---------- Хранение: localStorage + синхронизация с VK Storage ---------- */
function normalizeState() {
  if (!state.employees) state.employees = [];
  if (!state.stores) state.stores = [];
  if (!state.shifts) state.shifts = [];
  if (state.weekOffset === undefined) state.weekOffset = 0;
  if (typeof state.updatedAt !== 'number') state.updatedAt = 0;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {}
  normalizeState();
}

function saveState() {
  state.updatedAt = Date.now();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  scheduleVKSync();
}

/** Отложенная запись в VK Storage: не дёргаем клиент на каждое нажатие. */
function scheduleVKSync() {
  if (!isVK()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushStateToVK, STORAGE_SYNC_DELAY);
}

async function pushStateToVK() {
  const value = JSON.stringify(state);
  if (value === lastPushedValue) return;
  const ok = await vkStorageSet(VK_STORAGE_KEY, value);
  if (ok) lastPushedValue = value;
}

/**
 * Загрузка состояния из VK Storage при старте.
 * Конфликт решается по полю updatedAt: чья версия новее, та и побеждает.
 */
async function pullStateFromVK() {
  const raw = await vkStorageGet(VK_STORAGE_KEY);
  if (!raw) {
    // Облачного состояния ещё нет — отправляем локальное
    scheduleVKSync();
    return;
  }

  let remote;
  try { remote = JSON.parse(raw); } catch (e) { return; }
  if (!remote || !Array.isArray(remote.shifts)) return;

  lastPushedValue = raw;

  if ((remote.updatedAt || 0) > state.updatedAt) {
    state = remote;
    normalizeState();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    rerenderAll();
    toast('Данные обновлены из ВК');
  } else {
    scheduleVKSync();
  }
}

function rerenderAll() {
  renderSchedule();
  if (currentTab === 'stats') renderStats();
}

/* ---------- Даты ---------- */
function fmtISO(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseISO(s) {
  const [year, month, day] = s.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function showDate(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}

function showShort(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

function showTime(s) {
  return (s || '').slice(0, 5);
}

function getMonday(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const diff = x.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(x.setDate(diff));
}

function weekBounds(offset) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const mon = getMonday(today);
  mon.setDate(mon.getDate() + offset * 7);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 6);
  return { mon, sun };
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

/* ---------- UI: toast и диалоги (замена alert/confirm) ----------
   Нативные alert/confirm внутри iframe ВК работают некорректно,
   поэтому весь вывод идёт через наше модальное окно. */
let toastTimer = null;

function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('toast--show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--show'), 2600);
}

let dialogResolver = null;

function clearDialog() {
  if (!dialogResolver) return;
  const resolve = dialogResolver;
  dialogResolver = null;
  resolve(null);
}

/**
 * Модальное окно с кнопками.
 * @param {{title?: string, text?: string, extra?: HTMLElement, anchor?: Element|null, buttons?: Array<{label: string, primary?: boolean, value?: any}>}} opts
 *   `anchor` — кнопка, открывшая окно: окно будет строго центрировано относительно неё.
 * @returns {Promise<any>} значение нажатой кнопки или null, если окно закрыли
 */
function showDialog(opts) {
  clearDialog();

  const { title = '', text = '', extra = null, anchor = null, buttons = [] } = opts;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (dialogResolver === finish) dialogResolver = null;
      closeModal();
      resolve(value);
    };
    dialogResolver = finish;

    $('#modal-title').textContent = title;

    const body = $('#modal-body');
    body.innerHTML = '';
    if (text) {
      const p = document.createElement('div');
      p.className = 'dialog-text';
      p.textContent = text;
      body.appendChild(p);
    }
    if (extra) body.appendChild(extra);

    const footer = $('#modal-footer');
    footer.innerHTML = '';

    buttons.forEach((b) => {
      const btn = document.createElement('button');
      const style = b.danger ? 'btn--danger' : (b.primary ? 'btn--primary' : 'btn--outline');
      btn.className = 'btn ' + style + ' btn--full';
      btn.textContent = b.label;
      btn.onclick = () => finish(b.value);
      footer.appendChild(btn);
    });

    openModal(anchor);
  });
}

function confirmDialog(text, okLabel = 'Да', anchor = null) {
  return showDialog({
    title: 'Подтверждение',
    text,
    anchor,
    buttons: [
      { label: 'Отмена', value: false, danger: true },
      { label: okLabel, primary: true, value: true }
    ]
  });
}

/* ---------- Сотрудники ---------- */
function getEmployeeByName(name) {
  return state.employees.find(e => e.name === name) || null;
}

function addEmployee(name, vkId = null) {
  const existing = getEmployeeByName(name);
  if (existing) {
    if (vkId && !existing.vkId) { existing.vkId = vkId; saveState(); }
    return existing;
  }
  const e = {
    id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6),
    name,
    vkId
  };
  state.employees.push(e);
  saveState();
  return e;
}

/* ---------- Модальное окно ---------- */
/** Элемент, относительно которого окно центрируется (кнопка, открывшая попап). */
let modalAnchor = null;

function openModal(anchor = null) {
  modalAnchor = anchor || null;
  $('#overlay').classList.remove('hidden');
  $('#modal').classList.remove('hidden');
  positionModal();
}

/**
 * Строгое центрирование окна относительно кнопки-источника.
 * Без anchor окно центрируется в экране. Позиция подгоняется так,
 * чтобы окно не выходило за границы viewport (иначе попап «уезжает» вниз).
 */
function positionModal() {
  const modal = $('#modal');
  if (!modal || modal.classList.contains('hidden')) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 12;
  const mw = modal.offsetWidth;
  const mh = modal.offsetHeight;

  let cx = vw / 2;
  let cy = vh / 2;

  // Крупное окно (например, «Рассылка») всегда центрируем по экрану:
  // центр относительно нижней кнопки увёл бы его вниз за край viewport.
  const big = mh > vh * 0.6;

  if (!big && modalAnchor && typeof modalAnchor.getBoundingClientRect === 'function') {
    const r = modalAnchor.getBoundingClientRect();
    if (r.width || r.height) {
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
    }
  }

  const left = Math.min(Math.max(pad, cx - mw / 2), Math.max(pad, vw - mw - pad));
  const top = Math.min(Math.max(pad, cy - mh / 2), Math.max(pad, vh - mh - pad));

  modal.style.transform = 'none';
  modal.style.left = Math.round(left) + 'px';
  modal.style.top = Math.round(top) + 'px';
}

function closeModal() {
  $('#overlay').classList.add('hidden');
  $('#modal').classList.add('hidden');
  modalAnchor = null;
  broadcastState = null;
  addShiftCtx = null;
  clearDialog(); // закрытие по ✕/оверлею = ответ «нет» для активного диалога
}

window.addEventListener('resize', positionModal);
window.addEventListener('orientationchange', positionModal);

/* ---------- Вкладка: График ---------- */
const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function dayLabel(d) {
  return DAY_NAMES[(d.getDay() + 6) % 7] + ', ' + showDate(d);
}

function renderSchedule() {
  const { mon, sun } = weekBounds(state.weekOffset);
  // Формат даты по договорённости: «16.11 — 22.11. 2026» (точка, без запятой)
  $('#lbl-week').textContent = showShort(mon) + ' — ' + showShort(sun) + '. ' + mon.getFullYear();

  const list = $('#list-week');
  list.innerHTML = '';

  const weekShifts = state.shifts.filter(s => {
    const d = parseISO(s.date);
    return d >= mon && d <= sun;
  });

  const byDay = {};
  weekShifts.forEach(s => {
    if (!byDay[s.date]) byDay[s.date] = [];
    byDay[s.date].push(s);
  });

  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    const iso = fmtISO(d);

    const section = document.createElement('div');
    section.className = 'day-section';

    const head = document.createElement('div');
    head.className = 'day-section__head';

    const headText = document.createElement('span');
    headText.textContent = dayLabel(d);
    head.appendChild(headText);

    // «+ сотрудника» — добавление смены именно в этот день
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'day-add';
    addBtn.textContent = '+ сотрудника';
    addBtn.onclick = () => openAddShift(iso, addBtn);
    head.appendChild(addBtn);

    const items = document.createElement('div');
    items.className = 'day-section__items';

    // Сортировка смен по времени
    (byDay[iso] || []).sort((a, b) => a.time.localeCompare(b.time)).forEach(s => {
      const emp = state.employees.find(e => e.id === s.employeeId) || { name: s.employeeName || 'Сотрудник' };
      const item = document.createElement('div');
      item.className = 'shift-item';
      item.innerHTML =
        '<div class="shift-item__info">' +
        '<div class="shift-item__who">' + escapeHtml(emp.name) + '</div>' +
        '<div class="shift-item__when">' + showTime(s.time) + ' · ' + (s.durationHours || 6) + ' ч</div>' +
        '<div class="shift-item__store">' + escapeHtml(s.store || '—') + '</div>' +
        '</div>' +
        '<button class="shift-item__del" data-id="' + s.id + '" title="Удалить смену">×</button>' +
        '<button class="btn-cal" data-id="' + s.id + '" title="Добавить в календарь">📅</button>';
      item.querySelector('.shift-item__del').onclick = (ev) => { ev.stopPropagation(); deleteShift(s.id, ev.currentTarget); };
      item.querySelector('.btn-cal').onclick = (ev) => { ev.stopPropagation(); downloadICSShift(s.id); };
      items.appendChild(item);
    });

    section.appendChild(head);
    section.appendChild(items);
    list.appendChild(section);
  }
}

async function deleteShift(id, anchor) {
  const ok = await confirmDialog('Удалить эту смену?', 'Удалить', anchor);
  if (!ok) return;
  state.shifts = state.shifts.filter(s => s.id !== id);
  saveState();
  renderSchedule();
  toast('Смена удалена');
}

/* ---------- Добавление смены: шаг 1 (сотрудник) → шаг 2 (время) ---------- */

/**
 * Мини-окно добавления смены в конкретный день.
 * @param {string} dateISO дата в формате YYYY-MM-DD
 * @param {Element} anchor кнопка «+ сотрудника», относительно которой центрируется окно
 */
function openAddShift(dateISO, anchor) {
  clearDialog();
  renderEmployeeStep(dateISO, anchor, {});
}

/** Контекст шага «выбор сотрудника» — чтобы не терять поиск и друзей при перерисовке. */
let addShiftCtx = null;

function renderEmployeeStep(dateISO, anchor, opts) {
  opts = opts || {};
  const date = parseISO(dateISO);
  addShiftCtx = {
    dateISO,
    anchor,
    friends: opts.friends || null,
    query: opts.query || '',
    hint: opts.hint || ''
  };

  $('#modal-title').textContent = 'Новая смена — ' + dayLabel(date);

  const body = $('#modal-body');
  const footer = $('#modal-footer');
  body.innerHTML = '';
  footer.innerHTML = '';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'input';
  search.placeholder = 'Поиск или новое имя';
  search.autocomplete = 'off';
  search.value = addShiftCtx.query;
  body.appendChild(search);

  const listBox = document.createElement('div');
  listBox.className = 'step-list';
  body.appendChild(listBox);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = addShiftCtx.hint;
  body.appendChild(hint);

  const fill = () => {
    const q = search.value.trim().toLowerCase();
    addShiftCtx.query = search.value;
    listBox.innerHTML = '';

    const known = state.employees.filter(e => !q || e.name.toLowerCase().indexOf(q) !== -1);
    if (known.length) {
      const t = document.createElement('div');
      t.className = 'step-section-title';
      t.textContent = 'Ваши сотрудники';
      listBox.appendChild(t);
      known.forEach(e => listBox.appendChild(employeeItem(e, anchor, dateISO)));
    }

    const exact = state.employees.some(e => e.name.toLowerCase() === q);
    if (q && !exact) {
      const div = document.createElement('div');
      div.className = 'picker-item';
      div.innerHTML = '<div class="picker-item__name">Добавить «' + escapeHtml(search.value.trim()) + '»</div>' +
        '<div class="picker-item__act">Новый</div>';
      div.onclick = () => {
        const emp = addEmployee(search.value.trim());
        renderTimeStep(dateISO, anchor, emp);
      };
      listBox.appendChild(div);
    }

    const friends = addShiftCtx.friends;
    if (friends && friends.length) {
      const shown = friends.filter(f => {
        const n = ((f.first_name || '') + ' ' + (f.last_name || '')).trim().toLowerCase();
        return !q || n.indexOf(q) !== -1;
      });
      if (shown.length) {
        const t = document.createElement('div');
        t.className = 'step-section-title';
        t.textContent = 'Друзья ВК';
        listBox.appendChild(t);
        shown.forEach(f => {
          const name = ((f.first_name || '') + ' ' + (f.last_name || '')).trim();
          const div = document.createElement('div');
          div.className = 'picker-item';
          div.innerHTML = '<div class="picker-item__name">' + escapeHtml(name) + '</div>' +
            '<div class="picker-item__act">Выбрать</div>';
          div.onclick = () => {
            const emp = addEmployee(name, f.id || null);
            renderTimeStep(dateISO, anchor, emp);
          };
          listBox.appendChild(div);
        });
      }
    }

    if (!listBox.children.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Ничего не найдено';
      listBox.appendChild(e);
    }
  };

  search.oninput = fill;
  fill();

  // Загрузка друзей ВК
  const friendsBtn = document.createElement('button');
  friendsBtn.type = 'button';
  friendsBtn.className = 'btn btn--outline btn--full';
  friendsBtn.style.marginTop = '10px';
  if (!isVK()) {
    friendsBtn.disabled = true;
    friendsBtn.textContent = 'Друзья ВК — только внутри ВК';
  } else {
    friendsBtn.textContent = (addShiftCtx.friends && addShiftCtx.friends.length)
      ? 'Обновить список друзей'
      : 'Загрузить друзей ВК';
    friendsBtn.onclick = () => loadFriends(friendsBtn, hint);
  }
  body.appendChild(friendsBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--danger btn--full';
  closeBtn.textContent = 'Отмена';
  closeBtn.onclick = closeModal;
  footer.appendChild(closeBtn);

  openModal(anchor);
  setTimeout(() => { try { search.focus(); } catch (e) {} }, 60);
}

async function loadFriends(btn, hint) {
  const ctx = addShiftCtx;
  if (!ctx) return;
  btn.disabled = true;
  btn.textContent = 'Загружаем друзей…';
  hint.textContent = '';
  try {
    const users = await vkGetFriends();
    renderEmployeeStep(ctx.dateISO, ctx.anchor, {
      friends: users,
      query: ctx.query,
      hint: users.length ? 'Найдено друзей: ' + users.length : 'Друзей не найдено'
    });
  } catch (e) {
    hint.textContent = 'Не удалось загрузить друзей — введите имя вручную';
    btn.disabled = false;
    btn.textContent = 'Повторить';
  }
}

function employeeItem(e, anchor, dateISO) {
  const div = document.createElement('div');
  div.className = 'picker-item';
  const meta = e.vkId ? 'Есть ID ВК — можно отправить график' : 'Без ID ВК — только копирование';
  div.innerHTML = '<div><div class="picker-item__name">' + escapeHtml(e.name) + '</div>' +
    '<div class="picker-item__meta">' + meta + '</div></div>' +
    '<div class="picker-item__act">Выбрать</div>';
  div.onclick = () => renderTimeStep(dateISO, anchor, e);
  return div;
}

/** Шаг 2: время начала и длительность смены. */
function renderTimeStep(dateISO, anchor, emp) {
  $('#modal-title').textContent = 'Смена — ' + dayLabel(parseISO(dateISO));

  const body = $('#modal-body');
  const footer = $('#modal-footer');
  body.innerHTML = '';
  footer.innerHTML = '';

  const who = document.createElement('div');
  who.className = 'step-head';
  who.innerHTML = '<span>Сотрудник:</span><b></b>';
  who.querySelector('b').textContent = emp.name;
  body.appendChild(who);

  const row1 = document.createElement('div');
  row1.className = 'form__row grid-2';
  row1.innerHTML =
    '<div><label class="form__label">Начало смены</label>' +
    '<input type="time" id="np-time" class="input" value="09:00" /></div>' +
    '<div><label class="form__label">Длительность (ч)</label>' +
    '<input type="number" id="np-duration" class="input" min="0.5" step="0.5" value="6" /></div>';
  body.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'form__row';
  row2.innerHTML =
    '<label class="form__label">Точка магазина (необязательно)</label>' +
    '<input type="text" id="np-store" class="input" list="np-stores" placeholder="Название точки" />' +
    '<datalist id="np-stores"></datalist>';
  body.appendChild(row2);

  const dl = row2.querySelector('#np-stores');
  state.stores.forEach(st => {
    const o = document.createElement('option');
    o.value = st;
    dl.appendChild(o);
  });

  const backBtn = document.createElement('button');
  backBtn.className = 'btn btn--outline';
  backBtn.textContent = '← Назад';
  backBtn.onclick = () => renderEmployeeStep(dateISO, anchor);

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn--primary';
  addBtn.textContent = 'Добавить смену';
  addBtn.onclick = () => {
    const time = row1.querySelector('#np-time').value;
    const duration = parseFloat(row1.querySelector('#np-duration').value) || 6;
    const store = row2.querySelector('#np-store').value.trim();

    if (!time) { toast('Укажите время начала смены'); return; }
    if (duration < 0.5) { toast('Длительность должна быть от 0.5 часа'); return; }

    if (store && !state.stores.includes(store)) state.stores.push(store);

    state.shifts.push({
      id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
      employeeId: emp.id,
      employeeName: emp.name,
      store,
      date: dateISO,
      time,
      durationHours: duration
    });
    saveState();
    closeModal();
    renderSchedule();
    toast('Смена добавлена: ' + emp.name);
  };

  footer.appendChild(backBtn);
  footer.appendChild(addBtn);

  openModal(anchor);
  const t = row1.querySelector('#np-time');
  setTimeout(() => { try { t.focus(); } catch (e) {} }, 60);
}

/* ---------- Вкладка: Статистика ---------- */
function renderStats() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  $('#lbl-month').textContent = now.toLocaleString('ru', { month: 'long', year: 'numeric' }) + ' — статистика';

  const list = $('#list-stats');
  list.innerHTML = '';

  const byEmp = {};
  state.shifts.forEach(s => {
    const d = parseISO(s.date);
    if (d >= first && d <= last) {
      if (!byEmp[s.employeeId]) byEmp[s.employeeId] = { name: s.employeeName, shifts: 0, hours: 0 };
      byEmp[s.employeeId].shifts += 1;
      byEmp[s.employeeId].hours += s.durationHours || 0;
    }
  });

  const arr = Object.values(byEmp);
  if (arr.length === 0) {
    list.innerHTML = '<div class="empty">В этом месяце смен нет</div>';
    return;
  }
  arr.forEach(a => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML =
      '<div class="stat-card__name">' + escapeHtml(a.name) + '</div>' +
      '<div class="stat-row"><span>Смен</span><b>' + a.shifts + '</b></div>' +
      '<div class="stat-row"><span>Часов</span><b>' + a.hours + '</b></div>';
    list.appendChild(card);
  });
}

/* ---------- Рассылка графиков ---------- */
/** { items: [{emp, text, lines, shifts, selected}], sending: bool, anchor } */
let broadcastState = null;

function openBroadcast(anchor) {
  clearDialog(); // освобождаем модалку, если открыт диалог

  const { mon, sun } = weekBounds(state.weekOffset);
  const weekShifts = state.shifts.filter(s => {
    const d = parseISO(s.date);
    return d >= mon && d <= sun;
  });
  if (weekShifts.length === 0) {
    toast('На эту неделю нет смен для рассылки');
    return;
  }

  const byEmp = {};
  weekShifts.forEach(s => {
    if (!byEmp[s.employeeId]) byEmp[s.employeeId] = { name: s.employeeName, shifts: [] };
    byEmp[s.employeeId].shifts.push(s);
  });

  const body = $('#modal-body');
  const footer = $('#modal-footer');
  $('#modal-title').textContent = 'Рассылка графиков на неделю';
  body.innerHTML = '';
  footer.innerHTML = '';

  const period = showShort(mon) + ' — ' + showShort(sun) + '. ' + mon.getFullYear();

  const status = document.createElement('div');
  status.className = 'broadcast-status';
  status.id = 'broadcast-status';
  body.appendChild(status);

  const items = Object.values(byEmp).map(emp => {
    const shifts = emp.shifts.slice().sort((a, b) => a.time.localeCompare(b.time));
    const lines = shifts.map(s =>
      '• ' + showDate(parseISO(s.date)) + ' ' + showTime(s.time) +
      ' — ' + (s.store || '—') + ' (' + (s.durationHours || 6) + ' ч)'
    ).join('\n');
    const text =
      'Здравствуйте, ' + emp.name + '!\n' +
      'Ваш график смен на неделю с ' + period + ':\n' +
      lines + '\n\n' +
      'Файл календаря (.ics) прикреплён — откройте его, чтобы смены появились в календаре телефона.\n';
    return {
      emp: { id: null, name: emp.name, vkId: findVkId(emp.name) },
      text,
      lines,
      shifts,
      selected: true
    };
  });

  broadcastState = { items, sending: false, anchor };

  const noVk = items.filter(i => !i.emp.vkId);
  setStatus(
    'Получателей: ' + items.filter(i => i.emp.vkId).length + ' из ' + items.length +
    (noVk.length ? '\nБез ID ВК (можно только скопировать): ' + noVk.map(i => i.emp.name).join(', ') : ''),
    status
  );

  items.forEach((it, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'broadcast-item';

    const pick = document.createElement('div');
    pick.className = 'broadcast-pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'bcast-' + idx;
    cb.checked = true;
    cb.onchange = () => { it.selected = cb.checked; refreshSendButtons(); };
    const lb = document.createElement('label');
    lb.setAttribute('for', cb.id);
    lb.textContent = it.emp.name;
    pick.appendChild(cb);
    pick.appendChild(lb);
    if (!it.emp.vkId) {
      const warn = document.createElement('span');
      warn.className = 'broadcast-novkid';
      warn.textContent = 'нет ID ВК';
      pick.appendChild(warn);
    }
    wrap.appendChild(pick);

    const linesBox = document.createElement('div');
    linesBox.className = 'broadcast-item__text';
    linesBox.textContent = it.lines;
    wrap.appendChild(linesBox);

    const acts = document.createElement('div');
    acts.style.display = 'flex';
    acts.style.gap = '8px';
    acts.style.flexWrap = 'wrap';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn--outline btn--small';
    copyBtn.textContent = 'Копировать';
    copyBtn.onclick = () => copyText(it.text);

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn--outline btn--small';
    sendBtn.textContent = 'Отправить в ЛС';
    sendBtn.disabled = !it.emp.vkId;
    sendBtn.onclick = () => runBroadcast('both', [it]);

    acts.appendChild(copyBtn);
    acts.appendChild(sendBtn);
    wrap.appendChild(acts);

    body.appendChild(wrap);
  });

  const mk = (label, primary, mode) => {
    const b = document.createElement('button');
    b.className = 'btn ' + (primary ? 'btn--primary' : 'btn--outline');
    b.textContent = label;
    if (mode) b.dataset.sendMode = mode;
    b.onclick = () => runBroadcast(mode);
    return b;
  };

  const sendBoth = mk('Отправить всем (текст + .ics)', true, 'both');
  const sendText = mk('Отправить текст', false, 'text');
  const sendFile = mk('Отправить .ics', false, 'file');
  const copyAll = mk('Копировать всё', false, null);
  copyAll.onclick = () => copyText(allTextOf(items));

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--outline';
  closeBtn.textContent = 'Закрыть';
  closeBtn.onclick = closeModal;

  footer.appendChild(sendBoth);
  footer.appendChild(sendText);
  footer.appendChild(sendFile);
  footer.appendChild(copyAll);
  footer.appendChild(closeBtn);

  openModal(anchor);
  refreshSendButtons();
}

function allTextOf(items) {
  const { mon, sun } = weekBounds(state.weekOffset);
  return 'График смен на неделю с ' + showShort(mon) + ' — ' + showShort(sun) + '. ' + mon.getFullYear() + ':\n' +
    items.map(i => '\n--- ' + i.emp.name + ' ---\n' + i.text).join('\n');
}

function findVkId(name) {
  const e = state.employees.find(x => x.name === name);
  return (e && e.vkId) || null;
}

function setStatus(text, el) {
  const node = el || document.getElementById('broadcast-status');
  if (node) node.textContent = text;
}

function setSendButtonsDisabled(disabled) {
  $$('#modal-footer [data-send-mode]').forEach(b => { b.disabled = disabled; });
}

function refreshSendButtons() {
  if (!broadcastState) return;
  const any = broadcastState.items.some(i => i.selected && i.emp.vkId);
  $$('#modal-footer [data-send-mode]').forEach(b => {
    if (b.dataset.sendMode) b.disabled = broadcastState.sending || !any;
  });
}

/** Ключ доступа: только пользовательский (любой пользователь внутри ВК). */
async function getSendToken() {
  if (!isVK()) {
    console.error('getSendToken: приложение не запущено внутри ВК');
    return null;
  }
  let token = await vkGetUserAuthToken('messages');
  if (token) return { token, type: 'user' };
  return null;
}

/**
 * Отправка графика в ЛС сотрудников.
 * @param {'both'|'text'|'file'} mode 'both' — текст + файл одним сообщением
 * @param {Array|null} only ограничить список получателей (кнопка у конкретного сотрудника)
 */
async function runBroadcast(mode, only) {
  if (!broadcastState || broadcastState.sending) return;
  const bs = broadcastState;

  const pool = only || bs.items;
  const targets = pool.filter(i => i.selected !== false && i.emp.vkId);

  if (!targets.length) {
    toast(only ? 'У сотрудника нет ID ВК — график можно скопировать'
               : 'Выберите хотя бы одного сотрудника с ID ВК');
    return;
  }
  if (!isVK()) {
    toast('Отправка в ЛС работает только внутри ВК');
    return;
  }

  bs.sending = true;
  setSendButtonsDisabled(true);
  setStatus('Запрашиваем доступ к сообщениям…');

  let tokenInfo = null;
  let tokenError = null;
  try {
    tokenInfo = await getSendToken();
  } catch (e) {
    tokenError = (e && e.message) || String(e);
    tokenInfo = null;
  }

  if (!tokenInfo) {
    bs.sending = false;
    refreshSendButtons();
    if (broadcastState === bs) {
      setStatus('Доступ не получен.');
      await showDialog({
        title: 'Не удалось отправить',
        text: 'Не удалось получить ключ доступа к сообщениям.\n' +
              (tokenError ? 'Причина: ' + tokenError + '\n\n' : '') +
              'Нажмите «Отправить…» ещё раз и в появившемся окне ВК выберите «Разрешить».\n\n' +
              'Пока отправка недоступна — используйте «Копировать всё».',
        anchor: bs.anchor,
        buttons: [{ label: 'Понятно', primary: true, value: true }]
      });
    }
    return;
  }

  const { token } = tokenInfo;

  let sent = 0;
  let fileSent = 0;
  let fileError = null;
  let msgError = null;

  for (let i = 0; i < targets.length; i++) {
    const it = targets[i];
    if (broadcastState === bs) {
      setStatus('Отправка ' + (i + 1) + '/' + targets.length + ': ' + it.emp.name + '…');
    }

    let attachment = null;
    if (mode !== 'text') {
      if (fileError && mode === 'file') {
        continue;
      } else if (!fileError) {
        try {
          const ics = buildICSForShifts(it.shifts, it.emp.name);
          attachment = await vkUploadDoc(ics.text, ics.filename, token);
          fileSent++;
        } catch (e) {
          console.error('uploadDoc error:', e);
          fileError = (e && e.message) || 'загрузка файла не удалась';
          attachment = null;
          if (mode === 'file') continue;
        }
      }
    }

    const message = mode === 'file'
      ? 'Ваш график смен на неделю. Файл календаря .ics во вложении — откройте его, чтобы смены появились в календаре телефона.'
      : it.text;

    try {
      await vkSendMessage(it.emp.vkId, message, attachment, token);
      sent++;
    } catch (e) {
      console.error('sendMessage error:', e);
      msgError = (e && e.message) || 'ошибка отправки';
    }
  }

  bs.sending = false;
  refreshSendButtons();

  const parts = [];
  parts.push('Отправлено: ' + sent + ' из ' + targets.length);
  if (mode !== 'text') {
    parts.push(fileError
      ? 'Файл .ics не прикреплён: ' + fileError
      : 'Файлов .ics отправлено: ' + fileSent);
  }
  if (msgError) parts.push('Ошибки: ' + msgError);
  if (broadcastState === bs) setStatus(parts.join('\n'));

  if (mode === 'file' && fileError && sent === 0) {
    if (broadcastState === bs) {
      await showDialog({
        title: 'Файл .ics',
        text: 'Прикрепить файл не удалось: ' + fileError + '\n\nСкопируйте .ics вручную и отправьте его сотруднику.',
        anchor: bs.anchor,
        buttons: [{ label: 'Закрыть', primary: true, value: true }]
      });
    } else {
      toast('Файл .ics не отправлен: ' + fileError);
    }
    return;
  }

  if (mode === 'both' && fileError) {
    toast('Текст отправлен, файл .ics — нет. Кнопка «Отправить .ics» покажет причину.');
    return;
  }

  toast(sent ? 'График отправлен сотрудникам' : 'Ни одно сообщение не отправлено');
}

/** Копирование: VKWebAppCopyText → navigator.clipboard → ручное выделение текста. */
async function copyText(text) {
  const how = await vkCopyText(text);
  if (how) {
    toast(how === 'bridge' ? 'Скопировано в буфер обмена ВК' : 'Скопировано в буфер обмена');
    return;
  }

  const area = document.createElement('textarea');
  area.className = 'dialog-textarea';
  area.readOnly = true;
  area.value = text;
  await showDialog({
    title: 'Копирование',
    text: 'Автоматическое копирование недоступно. Выделите текст ниже и скопируйте его вручную.',
    extra: area,
    buttons: [{ label: 'Закрыть', primary: true, value: true }]
  });
}

/* ---------- Календарь .ics (iOS + Android) ---------- */
function pad(n) {
  return String(n).padStart(2, '0');
}

function icsDT(dateISO, time) {
  const d = new Date(dateISO + 'T' + time + ':00');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function addMinutesICS(dtStr, mins) {
  const d = new Date(
    dtStr.slice(0, 4) + '-' + dtStr.slice(4, 6) + '-' + dtStr.slice(6, 8) +
    'T' + dtStr.slice(9, 11) + ':' + dtStr.slice(11, 13) + ':' + dtStr.slice(13, 15)
  );
  d.setMinutes(d.getMinutes() + mins);
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

/** Экранирование значений по RFC 5545 (в .ics нельзя HTML-сущности). */
function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsEvent(shift, empName, uidSuffix) {
  const start = icsDT(shift.date, shift.time);
  const end = addMinutesICS(start, Math.round((shift.durationHours || 6) * 60));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const store = shift.store || 'Точка магазина';

  return [
    'BEGIN:VEVENT',
    'UID:' + shift.id + (uidSuffix || '') + '@vkshift',
    'DTSTAMP:' + stamp,
    'DTSTART:' + start,
    'DTEND:' + end,
    'SUMMARY:' + icsEscape('Смена — ' + store),
    'LOCATION:' + icsEscape(store),
    'DESCRIPTION:' + icsEscape('Сотрудник: ' + (empName || '') + '\nТочка: ' + store + '\nДлительность: ' + (shift.durationHours || 6) + ' ч'),
    'END:VEVENT'
  ];
}

function icsWrap(events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VK Shift App//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH'
  ].concat(events).concat([
    'END:VCALENDAR'
  ]).join('\r\n');
}

function buildICS(shift, empName) {
  return {
    text: icsWrap(icsEvent(shift, empName)),
    filename: 'смена_' + shift.date + '_' + shift.time.replace(':', '') + '.ics'
  };
}

/** Один файл .ics со всеми сменами сотрудника (для вложения в сообщение). */
function buildICSForShifts(shifts, empName) {
  const sorted = shifts.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const events = [];
  sorted.forEach((s, i) => events.push(...icsEvent(s, empName, '_' + i)));

  const { mon, sun } = weekBounds(state.weekOffset);
  return {
    text: icsWrap(events),
    filename: 'график_' + showShort(mon).replace('.', '-') + '-' + showShort(sun).replace('.', '-') + '.ics'
  };
}

/**
 * Скачивание через <a download> внутри iframe.
 * Никаких window.open / window.top / target=_blank — только скачивание в той же вкладке.
 */
function anchorDownload(text, filename) {
  try {
    const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // WebView может обработать клик не мгновенно — не отзываем URL сразу
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Экспорт смены в календарь.
 * В нативном клиенте ВК сначала пробуем VKWebAppDownloadFile (data:-URI),
 * затем обычное скачивание, и всегда предлагаем запасной путь — копирование .ics.
 */
async function exportICS(shift, empName) {
  const { text, filename } = buildICS(shift, empName);

  if (isNativeClient()) {
    let ok = false;
    try {
      ok = await vkDownloadFile('data:text/calendar;charset=utf-8,' + encodeURIComponent(text), filename);
    } catch (e) {
      ok = false;
    }

    if (ok) {
      toast('Файл .ics отправлен на скачивание. Если он не открылся — нажмите 📅 ещё раз');
      return;
    }

    anchorDownload(text, filename);
    showICSFallbackDialog(text, filename, () => exportICS(shift, empName));
    return;
  }

  anchorDownload(text, filename);
  toast('Файл .ics сохранён — откройте его в календаре');
}

function showICSFallbackDialog(text, filename, onRetry) {
  const area = document.createElement('textarea');
  area.className = 'dialog-textarea';
  area.readOnly = true;
  area.value = text;

  showDialog({
    title: 'Календарь .ics',
    text: 'Скачивание через ВК недоступно. Если файл «' + filename + '» не сохранился, скопируйте содержимое ниже, сохраните его в файл с расширением .ics и откройте в календаре.',
    extra: area,
    buttons: [
      { label: 'Скопировать .ics', primary: true, value: 'copy' },
      { label: 'Повторить', value: 'retry' },
      { label: 'Закрыть', value: null }
    ]
  }).then((res) => {
    if (res === 'copy') copyText(text);
    else if (res === 'retry' && onRetry) onRetry();
  });
}

async function downloadICSShift(id) {
  const s = state.shifts.find(x => x.id === id);
  if (!s) return;
  const emp = state.employees.find(e => e.id === s.employeeId) || { name: s.employeeName || '' };
  await exportICS(s, emp.name);
}

/* ---------- Инициализация ---------- */
function initVK() {
  // vk.js: VKWebAppInit, запрос конфига (тема + safe-area), цвет статус-бара
  return vkInit();
}

function navTabs() {
  $$('[data-tab]').forEach(b => {
    b.classList.toggle('tab--active', b.dataset.tab === currentTab);
    $('#page-' + b.dataset.tab).classList.toggle('hidden', b.dataset.tab !== currentTab);
  });
  if (currentTab === 'schedule') renderSchedule();
  else renderStats();
}

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  initVK();

  $$('[data-tab]').forEach(b => {
    b.onclick = () => { currentTab = b.dataset.tab; navTabs(); };
  });

  $('#btn-prev-week').onclick = () => { state.weekOffset--; saveState(); renderSchedule(); };
  $('#btn-next-week').onclick = () => { state.weekOffset++; saveState(); renderSchedule(); };

  $('#btn-broadcast').onclick = (ev) => openBroadcast(ev.currentTarget);

  $('#overlay').onclick = closeModal;

  renderSchedule();

  // Данные из VK Storage подтягиваются после отрисовки — старт не блокируется
  pullStateFromVK().catch(() => {});

  // Клавиатура внутри iframe ВК: активное поле ввода должно оставаться на экране
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    const type = el.type || 'text';
    if (!/^(text|search|date|time|number|tel|url|email)$/.test(type)) return;
    setTimeout(() => {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) {}
    }, 350);
  });
});
