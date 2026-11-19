const STORAGE_KEY = 'vkshifts_v1';
const bridge = window.vkBridge;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let currentTab = 'schedule';
let state = { employees: [], stores: [], shifts: [], weekOffset: 0 };

/* ---------- Хранение (localStorage) ---------- */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {}
  if (!state.employees) state.employees = [];
  if (!state.stores) state.stores = [];
  if (!state.shifts) state.shifts = [];
  if (state.weekOffset === undefined) state.weekOffset = 0;
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
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
  date.setHours(0, 0, 0, 0); // 👈 Важно: сбрасываем время!
  return date;
}

function showDate(d) {
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
}

function showShort(d) {
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month}`;
}

function getMonday(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const off = day === 0 ? -6 : 1 - day; // 0 = Вс, 1 = Пн, ..., 6 = Сб → сдвигаем на Пн
  x.setDate(x.getDate() + off);
  return x;
}
function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

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
  const e = { id: 'e' + Date.now() + Math.random().toString(36).slice(2, 6), name, vkId };
  state.employees.push(e);
  saveState();
  renderEmployeeDatalist();
  return e;
}

/* ---------- ВК: друзья ---------- */
async function loadVKFriends() {
  const hint = $('#hint-vk-friends');
  if (!bridge) { hint.textContent = 'VK Bridge недоступен (запустите внутри ВК)'; return; }
  try {
    const res = await bridge.send('VKWebAppGetFriends', { fields: ['first_name', 'last_name', 'photo_100'] });
    const items = (res && res.items) || [];
    hint.textContent = 'Найдено друзей: ' + items.length;
    openEmployeePicker(items);
  } catch (e) {
    hint.textContent = 'Не удалось загрузить друзей — добавьте сотрудника вручную';
  }
}
function openEmployeePicker(friends) {
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
  footer.innerHTML = '<button class="btn btn--primary btn--full" onclick="closeModal()">Закрыть</button>';
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
  weekShifts.forEach(s => { (byDay[s.date] = byDay[s.date] || []).push(s); });

  // 👇 Массив дней недели: Пн, Вт, Ср, Чт, Пт, Сб, Вс
  const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']; // 👈 Порядок getDay()

  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    const iso = fmtISO(d);

    // 👇 Корректируем индекс дня недели: 1 (Пн) → 1, 0 (Вс) → 6
    const dayOfWeek = (d.getDay() + 6) % 7;
    const dayName = dayNames[(d.getDay() + 6) % 7]; // 👈 Теперь Пн = 0, Вс = 6

    const section = document.createElement('div');
    section.className = 'day-section';
    section.innerHTML =
      '<div class="day-section__head">' + dayName + ', ' + showDate(d) + '</div>' +
      '<div class="day-section__items"></div>';
    const items = section.querySelector('.day-section__items');

    (byDay[iso] || []).forEach(s => {
      const emp = state.employees.find(e => e.id === s.employeeId) || { name: s.employeeName || 'Сотрудник' };
      const item = document.createElement('div');
      item.className = 'shift-item';
      item.innerHTML =
        '<div class="shift-item__info">' +
        '<div class="shift-item__who">' + escapeHtml(emp.name) + '</div>' +
        '<div class="shift-item__when">' + showTime(s.time) + ' · ' + (s.durationHours || 0) + ' ч</div>' +
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

  // Обновляем datalist для магазинов
  const sl = $('#stores-list');
  sl.innerHTML = '';
  state.stores.forEach(st => {
    const o = document.createElement('option');
    o.value = st;
    sl.appendChild(o);
  });
}

function deleteShift(id) {
  if (!confirm('Удалить эту смену?')) return;
  state.shifts = state.shifts.filter(s => s.id !== id);
  saveState();
  renderSchedule();
}

function downloadICSShift(id) {
  const s = state.shifts.find(x => x.id === id);
  if (!s) return;
  const emp = state.employees.find(e => e.id === s.employeeId) || { name: s.employeeName || '' };
  downloadICS(s, emp.name);
}

/* Форма добавления смены */
function handleFormSubmit(ev) {
  ev.preventDefault();
  const empName = $('#inp-employee').value.trim();
  const store = $('#inp-store').value.trim();
  const date = $('#inp-date').value;
  const time = $('#inp-time').value;
  const duration = parseFloat($('#inp-duration').value) || 8;

  if (!empName) { alert('Укажите сотрудника'); return; }
  if (!store) { alert('Укажите точку магазина'); return; }
  if (!date || !time) { alert('Укажите дату и время смены'); return; }

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
  $('#inp-duration').value = 8;
  $('#inp-date').value = fmtISO(new Date());
  renderSchedule();
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
  const { mon, sun } = weekBounds(state.weekOffset);
  const weekShifts = state.shifts.filter(s => {
    const d = parseISO(s.date);
    return d >= mon && d <= sun;
  });
  if (weekShifts.length === 0) {
    alert('На эту неделю нет смен для рассылки');
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
    const lines = emp.shifts.map(s =>
      '• ' + showDate(parseISO(s.date)) + ' ' + showTime(s.time) + ' — ' + escapeHtml(s.store) + ' (' + (s.durationHours || 0) + ' ч)'
    ).join('\n');
    const text =
      'Здравствуйте, ' + escapeHtml(emp.name) + '!\n' +
      'Ваш график смен на неделю с ' + showShort(mon) + ' по ' + showShort(sun) + ':\n' +
      lines + '\n\n' +
      'Чтобы добавить смену в календарь телефона (iOS/Android), используйте кнопку «📅» напротив смены в приложении «Назначение Смен» — будет скачан файл .ics.\n';
    allText += '\n--- ' + emp.name + ' ---\n' + text;

    const wrap = document.createElement('div');
    wrap.className = 'broadcast-item';
    wrap.innerHTML =
      '<div class="broadcast-item__head"><b>' + escapeHtml(emp.name) + '</b> — ' + emp.shifts.length + ' смен(ы)</div>' +
      '<div class="broadcast-item__text">' + escapeHtml(lines).replace(/\n/g, '<br>') + '</div>' +
      '<button class="btn btn--outline btn--small" onclick="app.copyText(\'' + escapeJs(text) + '\')">Копировать график</button>';
    body.appendChild(wrap);
  });

  footer.innerHTML =
    '<button class="btn btn--primary btn--full" onclick="app.copyText(\'' + escapeJs(allText) + '\')">Копировать всё (все сотрудники)</button>' +
    '<button class="btn btn--outline btn--full" onclick="closeModal()">Закрыть</button>';
  openModal();
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert('Текст скопирован в буфер обмена. Отправьте его сотрудникам в личные сообщения ВК.');
  }).catch(() => {
    alert('Не удалось скопировать. Выделите текст вручную.');
  });
}

/* ---------- Календарь .ics (iOS + Android) ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
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
function downloadICS(shift, empName) {
  const start = icsDT(shift.date, shift.time);
  const end = addMinutesICS(start, Math.round((shift.durationHours || 8) * 60));
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//VK Shift App//RU',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + shift.id + '@vkshift',
    'DTSTART:' + start,
    'DTEND:' + end,
    'SUMMARY:Смена — ' + escapeHtml(shift.store || 'Точка магазина'),
    'DESCRIPTION:Сотрудник: ' + escapeHtml(empName || '') + '\\nТочка: ' + escapeHtml(shift.store || ''),
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'смена_' + shift.date + '_' + shift.time.replace(':', '') + '.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const ua = navigator.userAgent;
  let hint = 'Файл календаря (.ics) скачан. Откройте его в календарном приложении.';
  if (/iphone|ipad|ipod/i.test(ua)) hint = 'iOS: откройте файл .ics — событие добавится в Календарь.';
  else if (/android/i.test(ua)) hint = 'Android: откройте файл .ics и добавьте событие в Google Календарь.';
  setTimeout(() => alert(hint), 100);
}

/* ---------- Инициализация ---------- */
function initVK() {
  if (bridge) {
    bridge.send('VKWebAppInit').catch(() => {});
  }
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

  // Дата по умолчанию — сегодня
  $('#inp-date').value = fmtISO(new Date());

  // Вкладки
  $$('[data-tab]').forEach(b => {
    b.onclick = () => { currentTab = b.dataset.tab; navTabs(); };
  });

  // Навигация недель
  $('#btn-prev-week').onclick = () => { state.weekOffset--; saveState(); renderSchedule(); };
  $('#btn-next-week').onclick = () => { state.weekOffset++; saveState(); renderSchedule(); };

  // Друзья ВК
  $('#btn-pick-employee').onclick = loadVKFriends;

  // Форма
  $('#form-shift').onsubmit = handleFormSubmit;

  // Рассылка
  $('#btn-broadcast').onclick = openBroadcast;

  // Кнопка быстрого перехода к форме
  $('#btn-add-shift').onclick = () => {
    $('#form-shift').scrollIntoView({ behavior: 'smooth' });
  };

  // Закрытие модалки
  $('#btn-modal-close').onclick = closeModal;
  $('#overlay').onclick = closeModal;

  // Первичный рендер
  renderSchedule();

  // Экспортируем для использования в HTML-атрибутах onclick
  window.app = { copyText, closeModal, openBroadcast };
});
