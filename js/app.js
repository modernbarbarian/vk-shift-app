import {
  init as vkInit,
  getFriends as vkGetFriends,
  copyText as vkCopyText,
  downloadFile as vkDownloadFile,
  storageGet as vkStorageGet,
  storageSet as vkStorageSet,
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
  renderEmployeeDatalist();
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
 * @param {{title?: string, text?: string, extra?: HTMLElement, buttons?: Array<{label: string, primary?: boolean, value?: any}>}} opts
 * @returns {Promise<any>} значение нажатой кнопки или null, если окно закрыли
 */
function showDialog(opts) {
  clearDialog();

  const { title = '', text = '', extra = null, buttons = [] } = opts;

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
      btn.className = 'btn ' + (b.primary ? 'btn--primary' : 'btn--outline') + ' btn--full';
      btn.textContent = b.label;
      btn.onclick = () => finish(b.value);
      footer.appendChild(btn);
    });

    openModal();
  });
}

function confirmDialog(text, okLabel = 'Да') {
  return showDialog({
    title: 'Подтверждение',
    text,
    buttons: [
      { label: 'Отмена', value: false },
      { label: okLabel, primary: true, value: true }
    ]
  });
}

/* ---------- Сотрудники ---------- */
function renderEmployeeDatalist() {
  const list = $('#employees-list');
  list.innerHTML = '';
  state.employees.forEach(e => {
    const o = document.createElement('option');
    o.value = e.name;
    o.dataset.id = e.id;
    list.appendChild(o);
  });
}

function getEmployeeByName(name) {
  return state.employees.find(e => e.name === name) || null;
}

function addEmployee(name, vkId = null) {
  const existing = getEmployeeByName(name);
  if (existing) return existing;
  const e = {
    id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6),
    name,
    vkId
  };
  state.employees.push(e);
  saveState();
  renderEmployeeDatalist();
  return e;
}

/* ---------- ВК: друзья ---------- */
async function loadVKFriends() {
  const hint = $('#hint-vk-friends');

  if (!isVK()) {
    hint.textContent = 'Список друзей доступен только внутри ВК — введите имя вручную';
    return;
  }

  hint.textContent = 'Загружаем друзей…';
  try {
    const users = await vkGetFriends();
    hint.textContent = users.length ? 'Найдено друзей: ' + users.length : 'Друзей не найдено';
    openEmployeePicker(users);
  } catch (e) {
    hint.textContent = 'Не удалось загрузить друзей — добавьте сотрудника вручную';
  }
}

function openEmployeePicker(friends) {
  clearDialog(); // освобождаем модалку, если открыт диалог

  const body = $('#modal-body');
  const footer = $('#modal-footer');
  $('#modal-title').textContent = 'Выберите сотрудника';
  body.innerHTML = '';
  if (friends && friends.length) {
    friends.forEach(f => {
      const name = ((f.first_name || '') + ' ' + (f.last_name || '')).trim();
      const div = document.createElement('div');
      div.className = 'picker-item';
      div.innerHTML = '<div class="picker-item__name">' + escapeHtml(name) + '</div><div class="picker-item__act">Добавить</div>';
      div.onclick = () => {
        addEmployee(name, f.id || null);
        closeModal();
        $('#inp-employee').value = name;
      };
      body.appendChild(div);
    });
  } else {
    body.innerHTML = '<div class="empty">Друзей не найдено</div>';
  }
  footer.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--primary btn--full';
  closeBtn.textContent = 'Закрыть';
  closeBtn.onclick = closeModal;
  footer.appendChild(closeBtn);
  openModal();
}

/* ---------- Модальное окно ---------- */
function openModal() {
  $('#overlay').classList.remove('hidden');
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#overlay').classList.add('hidden');
  $('#modal').classList.add('hidden');
  clearDialog(); // закрытие по ✕/оверлею = ответ «нет» для активного диалога
}

/* ---------- Вкладка: График ---------- */
function renderSchedule() {
  const { mon, sun } = weekBounds(state.weekOffset);
  $('#lbl-week').textContent = showShort(mon) + ' — ' + showShort(sun) + ', ' + mon.getFullYear();

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

  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    const iso = fmtISO(d);
    const dayIndex = (d.getDay() + 6) % 7;
    const dayName = dayNames[dayIndex];

    const section = document.createElement('div');
    section.className = 'day-section';
    section.innerHTML =
      '<div class="day-section__head">' + dayName + ', ' + showDate(d) + '</div>' +
      '<div class="day-section__items"></div>';
    const items = section.querySelector('.day-section__items');

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
      item.querySelector('.shift-item__del').onclick = (ev) => { ev.stopPropagation(); deleteShift(s.id); };
      item.querySelector('.btn-cal').onclick = (ev) => { ev.stopPropagation(); downloadICSShift(s.id); };
      items.appendChild(item);
    });

    list.appendChild(section);
  }

  const sl = $('#stores-list');
  sl.innerHTML = '';
  state.stores.forEach(st => {
    const o = document.createElement('option');
    o.value = st;
    sl.appendChild(o);
  });
}

async function deleteShift(id) {
  const ok = await confirmDialog('Удалить эту смену?', 'Удалить');
  if (!ok) return;
  state.shifts = state.shifts.filter(s => s.id !== id);
  saveState();
  renderSchedule();
  toast('Смена удалена');
}

function handleFormSubmit(ev) {
  ev.preventDefault();
  const empName = $('#inp-employee').value.trim();
  const store = $('#inp-store').value.trim();
  const date = $('#inp-date').value;
  const time = $('#inp-time').value;
  const duration = parseFloat($('#inp-duration').value) || 6; // Deafult: 6 часов

  if (!empName) { toast('Укажите сотрудника'); return; }
  if (!store) { toast('Укажите точку магазина'); return; }
  if (!date || !time) { toast('Укажите дату и время смены'); return; }

  const emp = addEmployee(empName);
  if (store && !state.stores.includes(store)) {
    state.stores.push(store);
    saveState();
  }

  state.shifts.push({
    id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
    employeeId: emp.id,
    employeeName: emp.name,
    store,
    date,
    time,
    durationHours: duration
  });
  saveState();

  $('#form-shift').reset();
  $('#inp-duration').value = 6; // Default: 6 часов
  $('#inp-date').value = fmtISO(new Date());
  renderSchedule();
  toast('Смена добавлена');
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
function openBroadcast() {
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

  let allText = 'График смен на неделю с ' + showShort(mon) + ' по ' + showShort(sun) + ':\n\n';

  Object.values(byEmp).forEach(emp => {
    // Текст для буфера обмена собираем «как есть», без HTML-экранирования
    const lines = emp.shifts
      .slice()
      .sort((a, b) => a.time.localeCompare(b.time))
      .map(s =>
        '• ' + showDate(parseISO(s.date)) + ' ' + showTime(s.time) +
        ' — ' + (s.store || '—') + ' (' + (s.durationHours || 6) + ' ч)'
      )
      .join('\n');
    const text =
      'Здравствуйте, ' + emp.name + '!\n' +
      'Ваш график смен на неделю с ' + showShort(mon) + ' по ' + showShort(sun) + ':\n' +
      lines + '\n\n' +
      'Чтобы добавить смену в календарь телефона (iOS/Android), используйте кнопку «📅» напротив смены в приложении «Назначение Смен» — будет скачан файл .ics.\n';
    allText += '\n--- ' + emp.name + ' ---\n' + text;

    const wrap = document.createElement('div');
    wrap.className = 'broadcast-item';

    const head = document.createElement('div');
    head.className = 'broadcast-item__head';
    const headName = document.createElement('b');
    headName.textContent = emp.name;
    head.appendChild(headName);
    head.appendChild(document.createTextNode(' — ' + emp.shifts.length + ' смен(ы)'));

    const linesBox = document.createElement('div');
    linesBox.className = 'broadcast-item__text';
    linesBox.textContent = lines;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn--outline btn--small';
    copyBtn.textContent = 'Копировать график';
    copyBtn.onclick = () => copyText(text);

    wrap.appendChild(head);
    wrap.appendChild(linesBox);
    wrap.appendChild(copyBtn);
    body.appendChild(wrap);
  });

  footer.innerHTML = '';
  const copyAllBtn = document.createElement('button');
  copyAllBtn.className = 'btn btn--primary btn--full';
  copyAllBtn.textContent = 'Копировать всё (все сотрудники)';
  copyAllBtn.onclick = () => copyText(allText);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--outline btn--full';
  closeBtn.textContent = 'Закрыть';
  closeBtn.onclick = closeModal;

  footer.appendChild(copyAllBtn);
  footer.appendChild(closeBtn);
  openModal();
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

function buildICS(shift, empName) {
  const start = icsDT(shift.date, shift.time);
  const end = addMinutesICS(start, Math.round((shift.durationHours || 6) * 60));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const store = shift.store || 'Точка магазина';

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VK Shift App//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + shift.id + '@vkshift',
    'DTSTAMP:' + stamp,
    'DTSTART:' + start,
    'DTEND:' + end,
    'SUMMARY:' + icsEscape('Смена — ' + store),
    'LOCATION:' + icsEscape(store),
    'DESCRIPTION:' + icsEscape('Сотрудник: ' + (empName || '') + '\nТочка: ' + store + '\nДлительность: ' + (shift.durationHours || 6) + ' ч'),
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  return {
    text: ics,
    filename: 'смена_' + shift.date + '_' + shift.time.replace(':', '') + '.ics'
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
  renderEmployeeDatalist();

  $('#inp-date').value = fmtISO(new Date());

  $$('[data-tab]').forEach(b => {
    b.onclick = () => { currentTab = b.dataset.tab; navTabs(); };
  });

  $('#btn-prev-week').onclick = () => { state.weekOffset--; saveState(); renderSchedule(); };
  $('#btn-next-week').onclick = () => { state.weekOffset++; saveState(); renderSchedule(); };

  $('#btn-pick-employee').onclick = loadVKFriends;

  $('#form-shift').onsubmit = handleFormSubmit;

  $('#btn-broadcast').onclick = openBroadcast;

  $('#btn-add-shift').onclick = () => {
    $('#form-shift').scrollIntoView({ behavior: 'smooth' });
  };

  $('#btn-modal-close').onclick = closeModal;
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
