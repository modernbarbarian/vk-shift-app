/**
 * Обёртка над VK Bridge для мини-приложения ВК.
 *
 * Задачи модуля:
 *  1. Инициализация мини-приложения (VKWebAppInit) и получение конфига
 *     (тема оформления, safe-area инсеты) → они применяются к документу.
 *  2. Доступ к API клиента ВК: друзья, буфер обмена, скачивание файла, VK Storage.
 *  3. Отсутствие жёстких зависимостей: вне ВК (GitHub Pages, локальный сервер)
 *     каждый метод безопасно отклоняется — приложение работает как обычная веб-страница.
 *
 * Важные особенности iframe ВК:
 *  - клиент не отвечает на некоторые вызовы → нужен таймаут, иначе Promise зависнет;
 *  - недоступные методы нужно проверять через supportsAsync, а не падать;
 *  - ссылок на window.top / window.open / прямых переходов в приложении нет
 *    (это запрещено в мини-приложениях), общение идёт только через bridge.
 */

/** Глобальный bridge: v3 экспортит window.vkBridge (и алиас window.vkConnect). */
export const bridge = (typeof window !== 'undefined' && (window.vkBridge || window.vkConnect)) || null;

const SEND_TIMEOUT = 6000;
const SUPPORT_TIMEOUT = 4000;
const STORAGE_MAX_VALUE = 60000; // лимит значения в VK Storage ~64 КБ

/** Поддерживаемые методы кэшируем: положительный ответ — надёжный, отрицательный — нет. */
const supportedCache = new Set();

let inited = false;
let currentAppearance = 'light';

/* ---------- Низкоуровневая отправка с таймаутом ---------- */

function rejectWith(method, errorType) {
  return Promise.reject({ error_type: errorType, error_data: { method } });
}

/**
 * Отправляет событие в клиент ВК и ждёт ответ не дольше `timeout`.
 * Без таймаута недоступный метод «зависает» навсегда и блокирует UI.
 */
export function send(method, params = {}, timeout = SEND_TIMEOUT) {
  if (!bridge) return rejectWith(method, 'no_bridge');

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject({ error_type: 'timeout', error_data: { method } });
    }, timeout);

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    try {
      const p = bridge.send(method, params);
      if (!p || typeof p.then !== 'function') {
        done(reject, { error_type: 'no_response', error_data: { method } });
        return;
      }
      p.then((res) => done(resolve, res)).catch((err) => done(reject, err));
    } catch (err) {
      done(reject, err);
    }
  });
}

/* ---------- Определение окружения ---------- */

/** Есть ли launch-параметры ВК в адресной строке (?vk_user_id=…&vk_group_id=…). */
function hasLaunchParams() {
  try {
    return /[?&#](vk_user_id|vk_group_id|vk_app_id|vk_platform)=/.test(
      window.location.search + window.location.hash
    );
  } catch (e) {
    return false;
  }
}

/**
 * Запущено ли приложение внутри ВК (iframe на vk.ru / мобильный клиент).
 * На GitHub Pages всегда false → все вызовы деградируют без ошибок.
 */
export function isVK() {
  if (!bridge) return false;
  try {
    if (bridge.isWebView() || bridge.isIframe() || bridge.isEmbedded()) return true;
  } catch (e) { /* игнорируем */ }
  return hasLaunchParams();
}

/**
 * Нативный клиент Android/iOS: здесь обычное скачивание <a download> ненадёжно,
 * поэтому для файлов используется VKWebAppDownloadFile.
 */
export function isNativeClient() {
  if (!bridge) return false;
  try {
    return !!bridge.isWebView();
  } catch (e) {
    return false;
  }
}

/** Проверка поддержки метода клиентом (с кэшированием положительного ответа). */
export async function supports(method) {
  if (!isVK()) return false;
  if (supportedCache.has(method)) return true;

  let ok = false;
  try {
    if (typeof bridge.supportsAsync === 'function') {
      ok = await Promise.race([
        bridge.supportsAsync(method),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), SUPPORT_TIMEOUT))
      ]);
    } else if (typeof bridge.supports === 'function') {
      ok = !!bridge.supports(method);
    }
  } catch (e) {
    ok = false;
  }

  if (ok) supportedCache.add(method);
  return !!ok;
}

/* ---------- Инициализация, тема и инсеты ---------- */

function applyConfig(data) {
  if (!data) return;

  const rawScheme = data.scheme || data.color_scheme || '';
  const appearance =
    data.appearance || (/(dark|space_gray|black)/i.test(rawScheme) ? 'dark' : 'light');

  currentAppearance = appearance === 'dark' ? 'dark' : 'light';

  const root = document.documentElement;
  root.setAttribute('data-appearance', currentAppearance);
  root.setAttribute('data-scheme', rawScheme || (currentAppearance === 'dark' ? 'space_gray' : 'bright_light'));
  root.style.colorScheme = currentAppearance;

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = currentAppearance === 'dark' ? '#19191a' : '#ffffff';

  // Safe-area (вырез/«челка» на iOS) — из VKWebAppUpdateConfig.insets
  const insets = data.insets;
  if (insets) {
    root.style.setProperty('--vk-safe-top', (insets.top || 0) + 'px');
    root.style.setProperty('--vk-safe-right', (insets.right || 0) + 'px');
    root.style.setProperty('--vk-safe-bottom', (insets.bottom || 0) + 'px');
    root.style.setProperty('--vk-safe-left', (insets.left || 0) + 'px');
  }

  // Размер окна-«родителя»: внутри iframe наш viewport может отличаться
  if (data.viewport_height) root.style.setProperty('--vk-vh', data.viewport_height + 'px');
  if (data.viewport_width) root.style.setProperty('--vk-vw', data.viewport_width + 'px');

  applyViewSettings();
}

/** Цвет статус-бара и шторки под текущую тему (best-effort, ошибка игнорируется). */
function applyViewSettings() {
  if (!isVK()) return;
  const dark = currentAppearance === 'dark';
  send('VKWebAppSetViewSettings', {
    status_bar_style: dark ? 'light' : 'dark', // «light» = светлые иконки на тёмном фоне
    action_bar_color: dark ? '#19191a' : '#ffffff',
    navigation_bar_color: dark ? '#19191a' : '#ffffff'
  }).catch(() => {});
}

/**
 * Инициализация мини-приложения: подписка на события клиента,
 * VKWebAppInit, запрос конфига (тема + инсеты).
 * Возвращает true, если bridge доступен.
 */
export function init(onConfig) {
  if (!bridge) return false;
  if (inited) return true;
  inited = true;

  const handle = (evt) => {
    const type = evt && evt.detail && evt.detail.type;
    if (type === 'VKWebAppUpdateConfig' || type === 'VKWebAppGetConfigResult') {
      applyConfig(evt.detail.data);
      if (typeof onConfig === 'function') onConfig(evt.detail.data);
    }
  };

  try {
    bridge.subscribe(handle);
  } catch (e) { /* игнорируем */ }

  // Первым делом — инициализация, без неё клиент не обрабатывает остальные события
  send('VKWebAppInit', {}, 8000)
    .catch(() => {})
    .then(() => send('VKWebAppGetConfig', {}, 5000))
    .then((config) => {
      applyConfig(config);
      if (typeof onConfig === 'function') onConfig(config);
    })
    .catch(() => {});

  return true;
}

/* ---------- API ---------- */

const API_VERSION = '5.199';

/** Кэш launch-параметров (нужны vk_app_id / vk_group_id для работы с API). */
let launchParamsCache = null;

/**
 * Launch-параметры мини-приложения (vk_user_id, vk_app_id, vk_group_id, …).
 * @returns {Promise<object|null>}
 */
export async function getLaunchParams() {
  if (launchParamsCache) return launchParamsCache;
  if (!isVK()) return null;
  try {
    const res = await send('VKWebAppGetLaunchParams', {}, 6000);
    if (res && res.vk_app_id) {
      launchParamsCache = res;
      return launchParamsCache;
    }
    // Если клиент не вернул vk_app_id, попробуем извлечь из URL
    const urlParams = new URLSearchParams(window.location.search + window.location.hash);
    const urlAppId = urlParams.get('vk_app_id');
    const urlUserId = urlParams.get('vk_user_id');
    const urlGroupId = urlParams.get('vk_group_id');
    if (urlAppId) {
      launchParamsCache = {
        vk_app_id: parseInt(urlAppId),
        vk_user_id: urlUserId ? parseInt(urlUserId) : undefined,
        vk_group_id: urlGroupId ? parseInt(urlGroupId) : undefined,
        vk_platform: urlParams.get('vk_platform') || 'desktop'
      };
      return launchParamsCache;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/** Ручная установка launch-параметров (если VK не передаёт их автоматически). */
export function setLaunchParams(params) {
  launchParamsCache = params;
}

/**
 * Пользовательский ключ доступа (для отправки сообщений от своего имени).
 * @param {string} scope например 'messages'
 * @returns {Promise<string|null>}
 */
export async function getUserAuthToken(scope = 'messages') {
  if (!isVK()) {
    console.error('getUserAuthToken: приложение не запущено внутри ВК');
    return null;
  }

  const lp = await getLaunchParams();
  const appId = lp && lp.vk_app_id;

  if (!appId) {
    console.error('getUserAuthToken: vk_app_id не найден — нельзя запросить токен');
    return null;
  }

  console.log('getUserAuthToken: запрос токена, app_id=' + appId + ', scope=' + scope);

  if (!(await supports('VKWebAppGetAuthToken'))) {
    console.error('getUserAuthToken: VKWebAppGetAuthToken не поддерживается клиентом');
    return null;
  }

  try {
    const res = await send('VKWebAppGetAuthToken', {
      app_id: appId,
      scope,
      result: true
    }, 12000);
    console.log('getUserAuthToken: ответ bridge', res);
    if (res && res.access_token) {
      return res.access_token;
    }
    console.error('getUserAuthToken: в ответе нет access_token');
  } catch (e) {
    console.error('getUserAuthToken: ошибка bridge', e);
  }
  return null;
}

/**
 * Вызов метода VK API через клиент ВК (без CORS: запрос делает сам клиент).
 * @returns {Promise<any>} результат метода
 * @throws если VK API вернул error
 */
export async function callApi(method, params = {}, timeout = 12000) {
  if (!(await supports('VKWebAppCallAPIMethod'))) {
    throw new Error('VKWebAppCallAPIMethod не поддерживается клиентом');
  }
  const res = await send(
    'VKWebAppCallAPIMethod',
    { method, params: Object.assign({}, params, { v: API_VERSION }) },
    timeout
  );

  // Клиент оборачивает ответ в { response: … } — снимаем один уровень вложенности
  let data = res;
  if (data && typeof data === 'object' && !Array.isArray(data) &&
      'response' in data && !('error' in data)) {
    data = data.response;
  }
  if (data && typeof data === 'object' && data.error) {
    const err = data.error;
    throw new Error((err.error_msg || 'VK API error') + ' (code ' + err.error_code + ')');
  }
  return data;
}

/**
 * Загрузка файла во ВК и получение строки-вложения `doc<owner_id>_<id>`.
 * Используется, чтобы отправить сотруднику файл .ics вместе с сообщением.
 * @returns {Promise<string>} строка для поля `attachment` метода messages.send
 */
export async function uploadDoc(fileText, filename, token) {
  const base = { access_token: token };

  const srv = await callApi('docs.getUploadServer', base, 12000);
  const uploadUrl = srv && srv.upload_url;
  if (!uploadUrl) throw new Error('Не удалось получить адрес загрузки файла');

  const fd = new FormData();
  fd.append('file', new Blob([fileText], { type: 'text/calendar;charset=utf-8' }), filename);

  const resp = await fetch(uploadUrl, { method: 'POST', body: fd, credentials: 'omit' });
  if (!resp.ok) throw new Error('Ошибка загрузки файла (HTTP ' + resp.status + ')');

  const saved = await resp.json();
  if (!saved || saved.error || !saved.file) {
    throw new Error((saved && saved.error && saved.error.error_msg) || 'Ошибка сохранения файла');
  }

  const res = await callApi('docs.save', Object.assign({}, base, {
    file: saved.file,
    title: filename
  }), 12000);

  const doc = res && (res.doc || (Array.isArray(res) && res[0] && res[0].doc));
  if (!doc || !doc.id) throw new Error('Файл не сохранён во ВК');
  return 'doc' + doc.owner_id + '_' + doc.id;
}

/**
 * Отправка сообщения в личные сообщения от имени пользователя.
 * @param {number} peerId id получателя (пользователя)
 * @param {string} message текст
 * @param {string|null} attachment строка вложения, например doc123_456
 * @param {string} token пользовательский токен
 */
export async function sendMessage(peerId, message, attachment, token) {
  const params = {
    access_token: token,
    peer_id: peerId,
    message: String(message),
    random_id: Math.floor(Date.now() % 1e9 * Math.random()) || 1
  };
  if (attachment) params.attachment = attachment;
  const res = await callApi('messages.send', params, 12000);
  return res;
}

/**
 * Список друзей пользователя.
 * Возвращает массив { id, first_name, last_name, photo_200 }.
 * Раньше результат читался из res.items — в актуальных версиях клиента это res.users.
 */
export async function getFriends() {
  const res = await send('VKWebAppGetFriends', {}, 8000);
  return (res && (res.users || res.items)) || [];
}

/**
 * Копирование текста в буфер обмена: сначала клиент ВК, затем обычный clipboard.
 * @returns {Promise<'bridge'|'clipboard'|null>}
 */
export async function copyText(text) {
  if (isVK() && (await supports('VKWebAppCopyText'))) {
    try {
      await send('VKWebAppCopyText', { text: String(text) }, 6000);
      return 'bridge';
    } catch (e) { /* пробуем обычный clipboard */ }
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(String(text));
      return 'clipboard';
    }
  } catch (e) { /* недоступно (не HTTPS, нет разрешения) */ }

  return null;
}

/**
 * Скачивание файла клиентом ВК (Android/iOS).
 * `url` должен быть http(s) или data: — blob-URL клиент увидеть не может.
 * @returns {Promise<boolean>} true — файл уходит на скачивание
 */
export async function downloadFile(url, filename) {
  if (!isVK() || !(await supports('VKWebAppDownloadFile'))) return false;
  try {
    const res = await send('VKWebAppDownloadFile', { url, filename }, 15000);
    return !!(res && res.result);
  } catch (e) {
    return false;
  }
}

/** Чтение переменной из VK Storage (привязана к пользователю, а не к устройству). */
export async function storageGet(key) {
  if (!isVK() || !(await supports('VKWebAppStorageGet'))) return null;
  try {
    const res = await send('VKWebAppStorageGet', { keys: [key] }, 8000);
    const items = (res && res.keys) || [];
    const found = items.find((k) => k.key === key);
    return found && typeof found.value === 'string' ? found.value : null;
  } catch (e) {
    return null;
  }
}

/** Запись переменной в VK Storage. */
export async function storageSet(key, value) {
  const str = String(value);
  if (str.length > STORAGE_MAX_VALUE) return false; // переполнение — молча оставляем localStorage
  if (!isVK() || !(await supports('VKWebAppStorageSet'))) return false;
  try {
    await send('VKWebAppStorageSet', { key, value: str }, 8000);
    return true;
  } catch (e) {
    return false;
  }
}

export function getAppearance() {
  return currentAppearance;
}
