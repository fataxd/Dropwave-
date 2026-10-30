const VERSION = '0.3.0';
const STEAM_LOGIN_URL = 'https://store.steampowered.com/login/?redir=account%2F&redir_ssl=1';
const SEARCH_URL = 'https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1';
const ALARM_NAME = 'steam-free-games-daily-check';
const RETRY_ALARM_NAME = 'steam-free-games-error-retry';
const DEFAULT_INTERVAL_HOURS = 24;
const ALLOWED_INTERVAL_HOURS = [6, 12, 24];
const HISTORY_LIMIT = 500;
const CLAIM_JOURNAL_LIMIT = 150;
const CLAIM_TAB_TIMEOUT_MS = 25000;
const CLAIMS_IN_PROGRESS = new Set();
let checkInFlight = null;
let accountWriteQueue = Promise.resolve();
let activationQueue = Promise.resolve();
let journalWriteQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults()
    .then(ensureCheckAlarm)
    .then(() => checkSteam({ notify: true }))
    .catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaults()
    .then(ensureCheckAlarm)
    .then(checkIfStale)
    .catch(console.error);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === RETRY_ALARM_NAME) {
    checkSteam({ notify: true }).catch(console.error);
  }
});

chrome.notifications.onClicked.addListener((notificationId) => {
  openNotificationTarget(notificationId).catch(console.error);
});

// Оставлено для совместимости с уведомлениями, созданными версиями 0.1.1–0.1.2.
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex !== 0) return;
  openNotificationTarget(notificationId).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === 'CHECK_NOW') {
    checkSteam({ notify: false })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'SET_AUTO_CHECK') {
    setAutoCheck(Boolean(message.enabled))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'SET_CHECK_INTERVAL') {
    const hours = normalizeIntervalHours(message.hours);
    setCheckInterval(hours)
      .then(() => sendResponse({ ok: true, hours }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'SET_CLAIMED') {
    setClaimed(String(message.appId || ''), Boolean(message.claimed))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'SET_AUTO_CLAIM') {
    const enabled = Boolean(message.enabled);
    (async () => {
      await setAutoClaim(enabled);
      // При включении не ждём следующего таймера: сразу перепроверяем текущие раздачи
      // и пытаемся забрать всё, что ещё не отмечено как полученное.
      let checkResult = null;
      let checkWarning = '';
      if (enabled) {
        try { checkResult = await checkSteam({ notify: false }); }
        catch (error) { checkWarning = readableError(error); }
      }
      return { ok: true, checkResult, checkWarning };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'CLEAR_JOURNAL') {
    clearCurrentAccountJournal()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'CLAIM_GAME') {
    const game = normalizeClaimGame(message.game);
    if (!game) {
      sendResponse({ ok: false, error: 'Некорректные данные игры.' });
      return false;
    }

    claimGame(game, { source: 'manual' })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'CHECK_STEAM_SESSION') {
    checkSteamStoreSessionAndActivate()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: readableError(error) }));
    return true;
  }

  if (message.type === 'OPEN_STEAM_LOGIN') {
    chrome.tabs.create({ url: STEAM_LOGIN_URL, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, tabId: tab?.id ?? null });
    });
    return true;
  }

  if (message.type === 'OPEN_URL' && typeof message.url === 'string') {
    const url = safeSteamUrl(message.url);
    if (!url) {
      sendResponse({ ok: false, error: 'Недопустимый адрес.' });
      return false;
    }
    chrome.tabs.create({ url });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function ensureDefaults() {
  const current = await chrome.storage.local.get([
    'autoCheck',
    'autoClaim',
    'checkIntervalHours',
    'seenAppIds',
    'currentGames',
    'history',
    'claimedAppIds',
    'legacyClaimedAppIds',
    'accountClaims',
    'claimJournal',
    'lastClaimResult',
    'version'
  ]);

  const patch = { version: VERSION };
  if (typeof current.autoCheck !== 'boolean') patch.autoCheck = true;
  if (typeof current.autoClaim !== 'boolean') patch.autoClaim = false;
  if (!ALLOWED_INTERVAL_HOURS.includes(Number(current.checkIntervalHours))) {
    patch.checkIntervalHours = DEFAULT_INTERVAL_HOURS;
  }
  if (!Array.isArray(current.seenAppIds)) patch.seenAppIds = [];
  if (!Array.isArray(current.currentGames)) patch.currentGames = [];
  if (!Array.isArray(current.history)) patch.history = [];
  // Legacy v0.2.7 combined manual checkmarks and confirmed licenses.
  // Do not trust these values for auto-claim skipping; preserve them as unverified marks.
  if (!current.accountClaims || typeof current.accountClaims !== 'object' || Array.isArray(current.accountClaims)) {
    patch.accountClaims = {};
  }
  if (!Array.isArray(current.legacyClaimedAppIds)) {
    patch.legacyClaimedAppIds = Array.isArray(current.claimedAppIds)
      ? current.claimedAppIds.filter((id) => /^\d+$/.test(String(id))).map(String)
      : [];
  }
  // Сохраняем последнее событие из v0.2.8 в новом журнале при первом запуске.
  if (!Array.isArray(current.claimJournal)) {
    const previous = current.lastClaimResult;
    patch.claimJournal = previous && /^\d+$/.test(String(previous.appId || ''))
      ? [{ ...previous, accountId: String(previous.accountId || ''), at: Number(previous.at) || Date.now() }]
      : [];
  }
  await chrome.storage.local.set(patch);
}

function normalizeIntervalHours(value) {
  const hours = Number(value);
  return ALLOWED_INTERVAL_HOURS.includes(hours) ? hours : DEFAULT_INTERVAL_HOURS;
}

async function ensureCheckAlarm() {
  const state = await chrome.storage.local.get(['autoCheck', 'checkIntervalHours']);
  const autoCheck = state.autoCheck !== false;
  const hours = normalizeIntervalHours(state.checkIntervalHours);
  const periodInMinutes = hours * 60;
  const alarm = await chrome.alarms.get(ALARM_NAME);

  if (!autoCheck) {
    if (alarm) await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(RETRY_ALARM_NAME);
    await chrome.storage.local.set({ nextCheckAt: 0, retryCheckAt: 0 });
    return;
  }

  if (!alarm || Number(alarm.periodInMinutes) !== periodInMinutes) {
    if (alarm) await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: periodInMinutes,
      periodInMinutes
    });
  }

  await updateNextCheckFromAlarm();
}

async function updateNextCheckFromAlarm() {
  const [alarm, retry] = await Promise.all([
    chrome.alarms.get(ALARM_NAME),
    chrome.alarms.get(RETRY_ALARM_NAME)
  ]);
  const times = [alarm?.scheduledTime, retry?.scheduledTime].filter(Number.isFinite);
  await chrome.storage.local.set({
    nextCheckAt: times.length ? Math.min(...times) : 0,
    retryCheckAt: Number.isFinite(retry?.scheduledTime) ? retry.scheduledTime : 0
  });
}

async function setAutoCheck(enabled) {
  await chrome.storage.local.set({ autoCheck: enabled });
  await ensureCheckAlarm();
}

async function setAutoClaim(enabled) {
  await chrome.storage.local.set({ autoClaim: enabled });
}

async function setCheckInterval(hours) {
  const normalized = normalizeIntervalHours(hours);
  await chrome.storage.local.set({ checkIntervalHours: normalized });
  await ensureCheckAlarm();
}

async function checkIfStale() {
  const state = await chrome.storage.local.get(['autoCheck', 'lastSuccess', 'lastAttemptAt', 'checkIntervalHours', 'retryCheckAt']);
  if (state.autoCheck === false) return;
  const staleMs = normalizeIntervalHours(state.checkIntervalHours) * 60 * 60 * 1000;
  const elapsed = Date.now() - Number(state.lastSuccess || 0);
  if (!state.lastSuccess || elapsed >= staleMs) {
    const retry = await chrome.alarms.get(RETRY_ALARM_NAME);
    if (!retry && (!state.lastAttemptAt || Date.now() - state.lastAttemptAt >= 10 * 60 * 1000)) {
      await checkSteam({ notify: true });
    } else if (!retry) {
      // Не создаём шквал запросов при нескольких быстрых перезапусках браузера.
      await scheduleRetry(10);
    }
  }
  await updateNextCheckFromAlarm();
}

// Один и тот же запрос используют popup, таймер и переключатель автополучения.
// Второй вызов получает то же Promise и не затирает историю параллельной проверкой.
function checkSteam({ notify = false } = {}) {
  if (checkInFlight) return checkInFlight;
  checkInFlight = performCheckSteam({ notify }).finally(() => { checkInFlight = null; });
  return checkInFlight;
}

async function scheduleRetry(minutes) {
  const state = await chrome.storage.local.get(['autoCheck']);
  if (state.autoCheck === false) return;
  await chrome.alarms.create(RETRY_ALARM_NAME, { delayInMinutes: minutes });
  await updateNextCheckFromAlarm();
}

async function performCheckSteam({ notify }) {
  const startedAt = Date.now();
  await chrome.storage.local.set({ checking: true, lastAttemptAt: startedAt });

  try {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('l', 'english');
    const searchResult = await fetchSteamSearchHtml(url.toString());
    await chrome.storage.local.set({ lastCheckTransport: searchResult.transport });

    const games = await enrichGamesWithGiveawayEnd(parseSteamSearch(searchResult.html));
    const state = await chrome.storage.local.get(['seenAppIds', 'autoClaim']);
    const seen = new Set((state.seenAppIds || []).map(String));
    const newGames = games.filter((game) => !seen.has(String(game.appId)));
    const updatedSeen = Array.from(new Set([
      ...seen, ...games.map((game) => String(game.appId))
    ])).slice(-1000);

    await updateHistory(games, startedAt);
    await chrome.storage.local.set({
      currentGames: games,
      seenAppIds: updatedSeen,
      lastCheck: startedAt,
      lastSuccess: Date.now(),
      lastError: '',
      checkFailureCount: 0
    });
    await chrome.alarms.clear(RETRY_ALARM_NAME);
    await updateBadge(games.length);

    const autoClaimResults = [];
    if (state.autoClaim === true) {
      const session = await checkSteamStoreSessionAndActivate();
      if (session.status === 'logged_in' && session.accountId) {
        const claimed = await getConfirmedClaims(session.accountId);
        for (const game of games) {
          if (claimed.has(String(game.appId))) continue;
          try {
            const result = await claimGame(game, { source: 'auto' });
            autoClaimResults.push({ appId: String(game.appId), result });
            if (result.status === 'success' || result.status === 'already_owned') claimed.add(String(game.appId));
            if (result.status === 'login_required' || result.status === 'identity_unknown') break;
          } catch (error) {
            autoClaimResults.push({
              appId: String(game.appId),
              result: { status: 'error', message: readableError(error) }
            });
          }
        }
      } else {
        autoClaimResults.push({
          appId: '', result: {
            status: 'login_required',
            message: 'Автополучение ожидает подтверждённого входа в Steam Store.'
          }
        });
      }
    }

    // Об ошибке или подтверждении уведомляем и для ранее найденной игры, если
    // статус автополучения изменился. Одинаковый статус не дублируем каждые 6–24 ч.
    const notificationState = await chrome.storage.local.get('autoClaimNoticeStatuses');
    const previousStatuses = notificationState.autoClaimNoticeStatuses &&
      typeof notificationState.autoClaimNoticeStatuses === 'object' &&
      !Array.isArray(notificationState.autoClaimNoticeStatuses)
      ? notificationState.autoClaimNoticeStatuses : {};
    const noticeStatuses = { ...previousStatuses };
    const newIds = new Set(newGames.map((game) => String(game.appId)));
    const gameById = new Map(games.map((game) => [String(game.appId), game]));
    const autoResultById = new Map(autoClaimResults.filter((item) => item.appId).map(
      (item) => [String(item.appId), item.result]
    ));
    const activeAccount = await chrome.storage.local.get('activeSteamAccountId');
    const accountPrefix = String(activeAccount.activeSteamAccountId || 'unknown');
    let notificationsSent = 0;
    if (notify) {
      for (const game of newGames.slice(0, 5)) {
        try {
          const result = autoResultById.get(String(game.appId));
          if (result) await showAutoClaimNotification(game, result);
          else await showGameNotification(game);
          notificationsSent++;
        } catch (error) { console.warn('Dropwave: notification failed', error); }
      }
    }
    for (const [appId, result] of autoResultById) {
      const key = `${accountPrefix}:${appId}`;
      const status = String(result?.status || 'unknown');
      const changed = previousStatuses[key] !== status;
      if (notify && changed && !newIds.has(appId) && notificationsSent < 5) {
        try {
          await showAutoClaimNotification(gameById.get(appId), result);
          notificationsSent++;
        } catch (error) { console.warn('Dropwave: status notification failed', error); }
      }
      // Храним последний известный статус даже для ручной проверки без уведомлений.
      // Отсюда видно изменение pending -> success в следующем фоновом цикле.
      delete noticeStatuses[key];
      noticeStatuses[key] = status;
    }
    const recentStatuses = Object.entries(noticeStatuses).slice(-1000);
    await chrome.storage.local.set({ autoClaimNoticeStatuses: Object.fromEntries(recentStatuses) });
    if (notify && newGames.length > 5) {
      try {
        await chrome.notifications.create('steam-free-summary', {
          type: 'basic', iconUrl: 'icons/icon128.png',
          title: 'Steam: новые бесплатные игры',
          message: `Найдено ${newGames.length} новых раздач. Нажмите на уведомление, чтобы открыть поиск Steam.`,
          requireInteraction: true
        });
      } catch (error) { console.warn('Dropwave: summary notification failed', error); }
    }

    await updateNextCheckFromAlarm();
    return { games, newGames, autoClaimResults, checkedAt: startedAt };
  } catch (error) {
    const message = readableError(error);
    const state = await chrome.storage.local.get(['checkFailureCount']);
    const failures = Math.min(10, Number(state.checkFailureCount || 0) + 1);
    await chrome.storage.local.set({ lastError: message, checkFailureCount: failures });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    // 10, 20, 40, 60 минут; не блокируем повторные проверки на 6–24 ч.
    await scheduleRetry(Math.min(60, 10 * Math.pow(2, Math.min(failures - 1, 3))));
    throw error;
  } finally {
    await chrome.storage.local.set({ checking: false });
  }
}

// Проверяем, что Steam вернул настоящую страницу результатов, а не страницу
// авторизации/ошибку/незагруженный AJAX-контейнер. Не стираем рабочие данные.
function validateSteamSearchHtml(html) {
  if (typeof html !== 'string' || html.length < 1000) throw new Error('Steam вернул слишком короткую страницу поиска');
  if (!/id=["']search_resultsRows["']|id=["']search_results["']/i.test(html)) {
    throw new Error('Steam не вернул контейнер результатов поиска (изменена разметка или страница недоступна)');
  }
  const sourceRows = (html.match(/<a\b[^>]*\bsearch_result_row\b/gi) || []).length;
  const parsedRows = (html.match(/<a\b[^>]*class=["'][^"']*\bsearch_result_row\b[^"']*["'][^>]*>/gi) || []).length;
  if (sourceRows > 0 && parsedRows === 0) {
    throw new Error('Steam изменил формат карточек раздач: поиск временно недостоверен');
  }
  if (sourceRows === 0 && !/\b0\s+(?:results?|items?)\b|no results (?:found|match|were returned)|no matching results/i.test(html)) {
    throw new Error('Steam не подтвердил отсутствие результатов: оставлены данные последней успешной проверки');
  }
  if (parsedRows > 0) {
    const rows = html.match(/<a\b[^>]*class=["'][^"']*\bsearch_result_row\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi) || [];
    if (rows.length !== parsedRows) throw new Error('Карточки Steam не удалось корректно разобрать');
    // Если все строки имеют скидку -100%, но наш парсер не распознаёт ни одной,
    // не делаем вывод об отсутствии раздач.
    const hasPromo = rows.some((row) => /discount_pct/i.test(row) && /[-−]\s*100\s*%/.test(cleanText(row)));
    if (hasPromo && parseSteamSearch(html).length === 0 && rows.some((row) => !/free weekend|play for free/i.test(cleanText(row)))) {
      throw new Error('Steam показал скидку 100%, но карточки игр не удалось распознать');
    }
  }
  return html;
}

async function fetchSteamSearchHtml(targetUrl) {
  const errors = [];
  const attempts = [
    { credentials: 'omit', transport: 'fetch-anonymous' },
    { credentials: 'include', transport: 'fetch-session' }
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        credentials: attempt.credentials,
        cache: 'no-store',
        headers: {
          'Accept': 'text/html,application/xhtml+xml'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      if (!html || html.length < 1000) {
        throw new Error('пустая или слишком короткая страница');
      }

      validateSteamSearchHtml(html);
      return { html, transport: attempt.transport };
    } catch (error) {
      errors.push(`${attempt.transport}: ${readableError(error)}`);
    }
  }

  // Если Brave/Chromium не дал service worker загрузить Steam Search,
  // пробуем выполнить same-origin fetch внутри уже открытой вкладки Steam Store.
  try {
    const existing = await fetchSteamSearchViaExistingStoreTab(targetUrl);
    if (existing?.html) {
      validateSteamSearchHtml(existing.html);
      return existing;
    }
  } catch (error) {
    errors.push(`existing-store-tab: ${readableError(error)}`);
  }

  // Последний резерв: кратковременно создаём неактивную вкладку Steam Search,
  // считываем уже загруженный HTML и сразу закрываем вкладку.
  try {
    const fallback = await fetchSteamSearchViaBackgroundTab(targetUrl);
    if (fallback?.html) {
      validateSteamSearchHtml(fallback.html);
      return fallback;
    }
  } catch (error) {
    errors.push(`background-tab: ${readableError(error)}`);
  }

  throw new Error(
    `Не удалось загрузить список раздач Steam. Вход в Steam Store может быть выполнен, но запрос поиска не прошёл. ${errors.join(' | ')}`
  );
}

async function fetchSteamSearchViaExistingStoreTab(targetUrl) {
  const tabs = await queryTabsCompat({ url: 'https://store.steampowered.com/*' });
  const tab = (tabs || []).find((item) => item && typeof item.id === 'number');
  if (!tab) return null;

  const results = await executeScriptWithArgsCompat(tab.id, steamSameOriginFetchHtml, [targetUrl]);
  const result = results && results[0] && results[0].result;
  if (!result || result.ok !== true || !result.html || result.html.length < 1000) {
    throw new Error(result?.error || `Steam tab HTTP ${result?.status || 'unknown'}`);
  }

  return { html: result.html, transport: 'existing-store-tab' };
}

async function fetchSteamSearchViaBackgroundTab(targetUrl) {
  let tabId = null;
  try {
    const tab = await createBackgroundTabCompat(targetUrl);
    if (!tab || typeof tab.id !== 'number') throw new Error('Не удалось создать служебную вкладку Steam');
    tabId = tab.id;

    await waitForTabComplete(tabId, CLAIM_TAB_TIMEOUT_MS);
    const results = await executeScriptCompat(tabId, pageOuterHtmlState);
    const result = results && results[0] && results[0].result;

    if (!result || !result.html || result.html.length < 1000) {
      throw new Error(result?.error || 'Steam Search загрузился без пригодного HTML');
    }

    return { html: result.html, transport: 'background-tab' };
  } finally {
    if (typeof tabId === 'number') {
      try {
        await removeTabCompat(tabId);
      } catch (_) {
        // Вкладка уже могла быть закрыта браузером/Steam.
      }
    }
  }
}

async function steamSameOriginFetchHtml(targetUrl) {
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const html = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      html,
      error: response.ok ? '' : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      html: '',
      error: error?.message || String(error)
    };
  }
}

function pageOuterHtmlState() {
  try {
    return {
      html: document.documentElement?.outerHTML || '',
      url: location.href
    };
  } catch (error) {
    return {
      html: '',
      url: location.href,
      error: error?.message || String(error)
    };
  }
}

function parseSteamSearch(html) {
  const rows = html.match(/<a\b[^>]*class="[^"]*\bsearch_result_row\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];
  const byAppId = new Map();

  for (const row of rows) {
    const appId = firstGroup(row, /data-ds-appid="(\d+)"/i);
    const href = decodeHtml(firstGroup(row, /href="([^"]+)"/i));
    const title = cleanText(firstGroup(row, /<span\b[^>]*class="title"[^>]*>([\s\S]*?)<\/span>/i));
    const discountPct = cleanText(firstGroup(row, /<div\b[^>]*class="discount_pct"[^>]*>([\s\S]*?)<\/div>/i));
    const originalPrice = cleanText(firstGroup(row, /<div\b[^>]*class="discount_original_price"[^>]*>([\s\S]*?)<\/div>/i));
    const finalPrice = cleanText(firstGroup(row, /<div\b[^>]*class="discount_final_price"[^>]*>([\s\S]*?)<\/div>/i));
    const image = decodeHtml(firstGroup(row, /<img\b[^>]*src="([^"]+)"/i));
    const rowText = cleanText(row).toLowerCase();

    if (!appId || !title || !href) continue;

    // Ключевой критерий: игра раньше стоила денег и сейчас имеет скидку ровно 100%.
    if (!/^[-−]\s*100\s*%$/.test(discountPct)) continue;
    if (!originalPrice || /^(free|free to play)$/i.test(originalPrice)) continue;

    // Защита от Free Weekend / временного доступа без выдачи лицензии.
    if (rowText.includes('free weekend') || rowText.includes('play for free')) continue;

    const safeUrl = safeSteamUrl(href);
    if (!safeUrl) continue;

    byAppId.set(String(appId), {
      appId: String(appId),
      title,
      url: safeUrl,
      image: image && image.startsWith('https://') ? image : '',
      originalPrice,
      finalPrice: finalPrice || 'Free',
      discountPct: '-100%',
      endAt: 0,
      endText: ''
    });
  }

  return Array.from(byAppId.values());
}

async function enrichGamesWithGiveawayEnd(games) {
  if (!games.length) return games;

  return Promise.all(games.map(async (game) => {
    const detailsUrl = new URL(game.url);
    detailsUrl.searchParams.set('l', 'english');

    // Срок раздачи Steam может скрывать на странице, если пользователь уже
    // получил игру. Поэтому сначала запрашиваем страницу анонимно — без cookie
    // текущего Steam-аккаунта. Это аналог просмотра страницы "как гость",
    // но без открытия окна инкогнито.
    try {
      const anonymousEnd = await fetchGiveawayEnd(detailsUrl.toString(), 'omit');
      if (anonymousEnd.endAt || anonymousEnd.endText) {
        return { ...game, ...anonymousEnd, endSource: 'anonymous' };
      }
    } catch (_) {
      // Ниже остаётся резервная проверка через обычную сессию Steam.
    }

    // Резервный вариант для случаев, когда Steam не отдал полезную анонимную
    // страницу (например, из-за региональной страницы или временной ошибки).
    try {
      const sessionEnd = await fetchGiveawayEnd(detailsUrl.toString(), 'include');
      if (sessionEnd.endAt || sessionEnd.endText) {
        return { ...game, ...sessionEnd, endSource: 'session' };
      }
    } catch (_) {
      // Не ломаем основную проверку, если страница конкретной игры недоступна.
    }

    return { ...game, endSource: 'unknown' };
  }));
}

async function fetchGiveawayEnd(url, credentialsMode) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: credentialsMode,
    cache: 'no-store',
    headers: {
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  if (!response.ok) {
    throw new Error(`Steam details HTTP ${response.status}`);
  }

  const html = await response.text();
  if (!html || html.length < 500) {
    throw new Error('Steam вернул пустую страницу игры');
  }

  return parseGiveawayEnd(html, Date.now());
}

function parseGiveawayEnd(html, nowMs) {
  const source = String(html || '');
  const now = Number(nowMs) || Date.now();

  // На случай, если Steam отдаёт Unix-время окончания в атрибуте или JSON.
  const unixPatterns = [
    /data-(?:discount-)?expiration=["'](\d{10,13})["']/i,
    /["']discount_expiration["']\s*:\s*["']?(\d{10,13})/i,
    /["']expiration["']\s*:\s*["']?(\d{10,13})/i
  ];

  for (const pattern of unixPatterns) {
    const value = firstGroup(source, pattern);
    if (!value) continue;
    const numeric = Number(value);
    const endAt = value.length <= 10 ? numeric * 1000 : numeric;
    if (Number.isFinite(endAt) && endAt > now - 24 * 60 * 60 * 1000 && endAt < now + 370 * 24 * 60 * 60 * 1000) {
      return { endAt, endText: '' };
    }
  }

  const text = cleanText(source);
  const phraseMatch = text.match(/Free to keep when you get it before\s+(.{3,80}?)(?=\.\s*(?:Some limitations apply|Add to Account|$))/i)
    || text.match(/Free to keep when you get it before\s+(.{3,80}?)(?:\.|$)/i);

  if (!phraseMatch) return { endAt: 0, endText: '' };

  const endText = phraseMatch[1].replace(/\s+/g, ' ').trim();
  return {
    endAt: parseSteamEnglishDate(endText, now),
    endText
  };
}

function parseSteamEnglishDate(value, nowMs) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*@\s*/g, ' @ ')
    .trim();

  const match = text.match(/^(?:(\d{1,2})\s+([A-Za-z]{3,9})|([A-Za-z]{3,9})\s+(\d{1,2}))(?:,?\s+(\d{4}))?\s*@\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return 0;

  const day = Number(match[1] || match[4]);
  const monthName = String(match[2] || match[3] || '').toLowerCase();
  const monthMap = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };
  const month = monthMap[monthName];
  if (!Number.isInteger(month) || day < 1 || day > 31) return 0;

  const now = new Date(Number(nowMs) || Date.now());
  let year = match[5] ? Number(match[5]) : now.getFullYear();
  let hour = Number(match[6]);
  const minute = Number(match[7] || 0);
  const meridiem = String(match[8] || '').toLowerCase();

  if (meridiem) {
    if (hour < 1 || hour > 12) return 0;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return 0;

  let candidate = new Date(year, month, day, hour, minute, 0, 0).getTime();
  if (!match[5] && candidate < now.getTime()) {
    year += 1;
    candidate = new Date(year, month, day, hour, minute, 0, 0).getTime();
  }

  return Number.isFinite(candidate) ? candidate : 0;
}

async function updateHistory(games, checkedAt) {
  const state = await chrome.storage.local.get(['history']);
  const history = Array.isArray(state.history) ? state.history : [];
  const byId = new Map(history.map((entry) => [String(entry.appId), { ...entry }]));
  const activeIds = new Set(games.map((game) => String(game.appId)));

  for (const game of games) {
    const id = String(game.appId);
    const existing = byId.get(id);
    const entry = {
      ...(existing || {}),
      ...game,
      appId: id,
      firstSeenAt: existing?.firstSeenAt || checkedAt,
      lastSeenAt: checkedAt,
      isActive: true,
      endedDetectedAt: 0
    };
    byId.set(id, entry);
  }

  for (const [id, entry] of byId.entries()) {
    if (activeIds.has(id)) continue;
    if (entry.isActive) {
      entry.isActive = false;
      entry.endedDetectedAt = checkedAt;
    }
  }

  const updated = Array.from(byId.values())
    .sort((a, b) => (b.firstSeenAt || 0) - (a.firstSeenAt || 0))
    .slice(0, HISTORY_LIMIT);

  await chrome.storage.local.set({ history: updated });
}

// Все отметки и реальные лицензии хранятся отдельно для каждого Steam-аккаунта.
// SERIALIZATION нужна, чтобы параллельные получения не затирали состояние друг друга.
function mutateAccountClaims(accountId, mutate) {
  const job = accountWriteQueue.then(async () => {
    const state = await chrome.storage.local.get(['accountClaims']);
    const claims = state.accountClaims && typeof state.accountClaims === 'object' ? state.accountClaims : {};
    const current = claims[accountId] || {};
    const item = {
      confirmed: Array.isArray(current.confirmed) ? current.confirmed : [],
      manual: Array.isArray(current.manual) ? current.manual : [],
      pending: Array.isArray(current.pending) ? current.pending : []
    };
    mutate(item);
    claims[accountId] = item;
    await chrome.storage.local.set({ accountClaims: claims });
    return item;
  });
  accountWriteQueue = job.catch(() => {});
  return job;
}

async function getConfirmedClaims(accountId) {
  const state = await chrome.storage.local.get('accountClaims');
  return new Set((state.accountClaims?.[accountId]?.confirmed || []).map(String));
}

async function setVerifiedClaim(appId, accountId, status) {
  await mutateAccountClaims(accountId, (entry) => {
    const verified = new Set(entry.confirmed.map(String));
    const pending = new Set(entry.pending.map(String));
    const manual = new Set(entry.manual.map(String));
    if (status === 'confirmed') {
      verified.add(appId);
      pending.delete(appId);
      manual.delete(appId);
    } else if (status === 'pending' && !verified.has(appId)) {
      pending.add(appId);
    }
    entry.confirmed = [...verified].slice(-1000);
    entry.manual = [...manual].slice(-1000);
    entry.pending = [...pending].slice(-1000);
  });
}

function activateAccountContext(session) {
  const accountId = session?.status === 'logged_in' && /^[0-9]+$/.test(String(session.accountId || ''))
    ? String(session.accountId) : '';
  const job = activationQueue.then(async () => {
    await chrome.storage.local.set({ activeSteamAccountId: accountId });
    if (!accountId) return;
    const state = await chrome.storage.local.get('legacyClaimedAppIds');
    if (Array.isArray(state.legacyClaimedAppIds) && state.legacyClaimedAppIds.length) {
      await mutateAccountClaims(accountId, (item) => {
        const manual = new Set([...item.manual, ...state.legacyClaimedAppIds].map(String));
        for (const verified of item.confirmed) manual.delete(String(verified));
        item.manual = [...manual].slice(-1000);
      });
      await chrome.storage.local.set({ legacyClaimedAppIds: [] });
    }
  });
  activationQueue = job.catch(() => {});
  return job;
}

async function checkSteamStoreSessionAndActivate() {
  const session = await checkSteamStoreSession();
  await activateAccountContext(session);
  return session;
}

async function setClaimed(appId, claimed) {
  if (!/^\d+$/.test(appId)) throw new Error('Некорректный AppID');
  const session = await checkSteamStoreSessionAndActivate();
  if (session.status !== 'logged_in' || !session.accountId) {
    throw new Error('Для ручной отметки требуется определить текущий Steam-аккаунт. Войдите в Steam Store.');
  }
  await mutateAccountClaims(session.accountId, (entry) => {
    const manual = new Set(entry.manual.map(String));
    if (claimed) manual.add(appId); else manual.delete(appId);
    entry.manual = [...manual].slice(-1000);
  });
}

function normalizeClaimGame(value) {
  if (!value || typeof value !== 'object') return null;
  const appId = String(value.appId || '').trim();
  if (!/^\d+$/.test(appId)) return null;

  const suppliedUrl = safeSteamUrl(value.url || '');
  const fallbackUrl = `https://store.steampowered.com/app/${appId}/`;
  const url = suppliedUrl || fallbackUrl;

  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/^\/app\/(\d+)(?:\/|$)/i);
    if (!pathMatch || pathMatch[1] !== appId) return null;
  } catch {
    return null;
  }

  return {
    appId,
    title: String(value.title || `App ${appId}`).trim().slice(0, 200),
    url
  };
}

async function checkSteamStoreSession() {
  // Быстрая проверка без вкладки. Положительный результат можно принять сразу.
  // Отрицательный результат fetch НЕ считаем окончательным: Brave/Chromium может
  // выполнить запрос из service worker не так, как обычная вкладка Steam.
  const direct = await checkSteamStoreSessionByFetch();
  if (direct.status === 'logged_in') return direct;

  // Авторитетная проверка выполняется в реальном контексте Steam Store.
  // Вкладка неактивная и закрывается сразу после чтения состояния.
  const target = 'https://store.steampowered.com/account/?l=english';
  let tabId = null;

  try {
    const tab = await createBackgroundTabCompat(target);
    if (!tab || typeof tab.id !== 'number') return direct;
    tabId = tab.id;

    await waitForTabComplete(tabId, CLAIM_TAB_TIMEOUT_MS);
    const results = await executeScriptMainCompat(tabId, steamSessionStateMain);
    const state = results && results[0] && results[0].result;

    return state && typeof state === 'object' ? state : direct;
  } catch (error) {
    return direct.status === 'login_required'
      ? direct
      : { status: 'unknown', message: readableError(error) || 'Не удалось проверить Steam Store.' };
  } finally {
    if (typeof tabId === 'number') {
      try { await removeTabCompat(tabId); } catch (_) {}
    }
  }
}

async function checkSteamStoreSessionByFetch() {
  const target = 'https://store.steampowered.com/account/?l=english';

  try {
    const response = await fetch(target, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow'
    });

    if (!response.ok) {
      return { status: 'unknown', message: `Steam Store ответил HTTP ${response.status}.` };
    }

    const finalUrl = String(response.url || target);
    const html = await response.text();

    // Steam публикует g_AccountID в HTML. 0 означает гостя, положительное значение —
    // авторизованный аккаунт. Это надёжнее привязки к конкретному CSS-id шапки.
    const accountMatch = html.match(/\bvar\s+g_AccountID\s*=\s*(\d+)\s*;/i);
    if (accountMatch && Number(accountMatch[1]) > 0) {
      return { status: 'logged_in', accountId: accountMatch[1], accountName: '', message: 'Вход в Steam Store выполнен.' };
    }

    try {
      const parsed = new URL(finalUrl);
      if (/\/login(?:\/|$)/i.test(parsed.pathname)) {
        return { status: 'login_required', message: 'Требуется вход в Steam Store.' };
      }
    } catch (_) {}

    if (accountMatch && Number(accountMatch[1]) === 0) {
      return { status: 'login_required', message: 'Требуется вход в Steam Store.' };
    }

    // Старые/альтернативные шаблоны Steam оставляем только дополнительными сигналами.
    if (/id=["']account_pulldown["']/i.test(html) || /class=["'][^"']*user_avatar/i.test(html)) {
      return { status: 'unknown', message: 'Страница похожа на авторизованную, но аккаунт пока не определён.' };
    }

    return { status: 'unknown', message: 'Steam Store ответил, но состояние входа требует проверки в странице.' };
  } catch (error) {
    return { status: 'unknown', message: readableError(error) || 'Тихая проверка Steam Store не удалась.' };
  }
}

function steamSessionStateMain() {
  const path = String(location.pathname || '');
  const accountId = Number(window.g_AccountID || 0);
  const steamId = window.g_steamID;
  const fallbackId = /^\d{17}$/.test(String(steamId || ''))
    ? BigInt(String(steamId)) - 76561197960265728n : 0n;
  const verifiedId = accountId > 0 ? String(accountId) : (fallbackId > 0n ? String(fallbackId) : '');

  if (verifiedId) {
    const accountPulldown = document.querySelector('#account_pulldown');
    const accountName = accountPulldown
      ? String(accountPulldown.textContent || '').replace(/\s+/g, ' ').trim()
      : '';
    return { status: 'logged_in', accountId: verifiedId, accountName, message: 'Вход в Steam Store выполнен.' };
  }

  if (/\/login(?:\/|$)/i.test(path)) {
    return { status: 'login_required', message: 'Требуется вход в Steam Store.' };
  }

  // Не опираемся на один конкретный id: Steam меняет шапку, но эти признаки
  // относятся к авторизованному интерфейсу.
  const loggedInMarker = document.querySelector('#account_pulldown, .user_avatar, #header_notification_area');
  if (loggedInMarker) {
    return { status: 'unknown', message: 'Steam показывает профиль, но не удалось определить ID аккаунта.' };
  }

  const signInLink = document.querySelector('#global_action_menu a[href*="/login"], a.global_action_link[href*="/login"]');
  if (signInLink) return { status: 'login_required', message: 'Требуется вход в Steam Store.' };

  return { status: 'unknown', message: 'Steam Store открылся, но состояние входа определить не удалось.' };
}

function steamAccountIdentityMain() {
  const accountId = Number(window.g_AccountID || 0);
  const steamId = String(window.g_steamID || '');
  const fallbackId = /^\d{17}$/.test(steamId)
    ? BigInt(steamId) - 76561197960265728n : 0n;
  return { accountId: accountId > 0 ? String(accountId) : (fallbackId > 0n ? String(fallbackId) : '') };
}

async function claimGame(game, { source = 'manual' } = {}) {
  const normalized = normalizeClaimGame(game);
  if (!normalized) throw new Error('Некорректные данные игры');

  if (CLAIMS_IN_PROGRESS.has(normalized.appId)) {
    return { status: 'busy', message: 'Эта игра уже обрабатывается Dropwave.' };
  }
  CLAIMS_IN_PROGRESS.add(normalized.appId);

  const target = new URL(normalized.url);
  target.searchParams.set('l', 'english');

  let tabId = null;
  let accountId = '';
  try {
    const tab = await createBackgroundTabCompat(target.toString());
    if (!tab || typeof tab.id !== 'number') throw new Error('Браузер не создал вкладку Steam');
    tabId = tab.id;

    await waitForTabComplete(tabId, CLAIM_TAB_TIMEOUT_MS);
    const identityResults = await executeScriptMainCompat(tabId, steamAccountIdentityMain);
    accountId = String(identityResults?.[0]?.result?.accountId || '');
    if (!/^[0-9]+$/.test(accountId)) {
      const result = { status: 'identity_unknown', message: 'Steam не предоставил ID авторизованного аккаунта. Получение остановлено.' };
      await saveLastClaimResult(normalized, result, source, '');
      return result;
    }
    await activateAccountContext({ status: 'logged_in', accountId });

    // Steam дорисовывает purchase-area после события complete, поэтому сама функция
    // ждёт нужный блок до 12 секунд и выполняет запрос на бесплатную лицензию
    // непосредственно в MAIN world страницы Steam.
    const results = await executeScriptWithArgsMainCompat(tabId, steamAcquireFreeLicenseMain, [normalized.appId]);
    const result = results && results[0] && results[0].result
      ? results[0].result
      : { status: 'error', message: 'Steam не вернул результат получения лицензии.' };

    if (result.status === 'success' || result.status === 'already_owned') {
      await setVerifiedClaim(normalized.appId, accountId, 'confirmed');
    } else if (result.status === 'pending') {
      await setVerifiedClaim(normalized.appId, accountId, 'pending');
    }

    await saveLastClaimResult(normalized, result, source, accountId);
    return result;
  } catch (error) {
    // Сетевые/DOM/вкладочные ошибки раньше вовсе не попадали в историю операций.
    // Не подменяем причину исходной ошибки, если запись журнала не удалась.
    try {
      await saveLastClaimResult(normalized, { status: 'error', message: readableError(error) }, source, accountId);
    } catch (journalError) {
      console.warn('Dropwave: claim journal write failed', journalError);
    }
    throw error;
  } finally {
    CLAIMS_IN_PROGRESS.delete(normalized.appId);
    if (typeof tabId === 'number') {
      try { await removeTabCompat(tabId); } catch (_) {}
    }
  }
}

async function steamAcquireFreeLicenseMain(expectedAppId) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const appId = String(expectedAppId || '');

  const loggedIn = () => {
    const accountId = Number(window.g_AccountID || 0);
    const steamId = window.g_steamID;
    if (accountId > 0 || (steamId && steamId !== false && steamId !== 'false')) return true;
    return Boolean(document.querySelector('#account_pulldown, .user_avatar, #header_notification_area'));
  };

  const ownsApp = async (subId = '') => {
    try {
      const response = await fetch(`/dynamicstore/userdata/?v=${Date.now()}`, {
        credentials: 'include', cache: 'no-store'
      });
      if (!response.ok) return false;
      const data = await response.json();
      const apps = Array.isArray(data?.rgOwnedApps) ? data.rgOwnedApps.map(String) : [];
      const packages = Array.isArray(data?.rgOwnedPackages) ? data.rgOwnedPackages.map(String) : [];
      return (appId && apps.includes(appId)) || (subId && packages.includes(String(subId)));
    } catch (_) {
      return false;
    }
  };

  if (/\/login(?:\/|$)/i.test(location.pathname) || !loggedIn()) {
    return { status: 'login_required', message: 'Нужно войти именно в Steam Store в этом браузере.' };
  }

  if (await ownsApp()) {
    return { status: 'already_owned', message: 'Игра уже есть в библиотеке Steam.' };
  }

  let giveawayBlock = null;
  let subId = '';

  for (let attempt = 0; attempt < 24; attempt++) {
    const bodyText = normalize(document.body ? document.body.innerText : '');
    const lower = bodyText.toLowerCase();

    if (
      document.querySelector('#agegate_box, .agegate_birthday_selector, select[name="ageYear"]') ||
      lower.includes('please enter your birth date') ||
      lower.includes('please enter your date of birth')
    ) {
      return { status: 'age_required', message: 'Steam просит подтвердить возраст на странице игры.' };
    }

    if (
      document.querySelector('.game_area_already_owned, .already_in_library') ||
      /already in your steam library/i.test(bodyText) ||
      /is in your steam library/i.test(bodyText) ||
      /successfully been added to your account/i.test(bodyText) ||
      /has been added to your account/i.test(bodyText)
    ) {
      return { status: 'already_owned', message: 'Игра уже есть в библиотеке Steam.' };
    }

    const blocks = Array.from(document.querySelectorAll('.game_area_purchase_game, .game_area_purchase_game_wrapper, [class*="game_area_purchase"]'));
    giveawayBlock = blocks.find((block) => /Free to keep when you get it before/i.test(normalize(block.innerText))) || null;

    if (!giveawayBlock && /Free to keep when you get it before/i.test(bodyText)) {
      giveawayBlock = Array.from(document.querySelectorAll('div, section'))
        .filter((node) => {
          const text = normalize(node.innerText);
          return /Free to keep when you get it before/i.test(text) && /Add to Account/i.test(text);
        })
        .sort((a, b) => normalize(a.innerText).length - normalize(b.innerText).length)[0] || null;
    }

    if (giveawayBlock) {
      const subInput = giveawayBlock.querySelector('input[name="subid"]');
      if (subInput && /^\d+$/.test(String(subInput.value || ''))) subId = String(subInput.value);

      if (!subId) {
        const dataNode = giveawayBlock.querySelector('[data-subid], [data-ds-packageid], [data-packageid]');
        const candidate = dataNode && (dataNode.getAttribute('data-subid') || dataNode.getAttribute('data-ds-packageid') || dataNode.getAttribute('data-packageid'));
        if (candidate && /^\d+$/.test(String(candidate))) subId = String(candidate);
      }

      if (!subId) {
        const markup = giveawayBlock.innerHTML || '';
        const match = markup.match(/AddFreeLicense\s*\(\s*(\d+)/i) ||
          markup.match(/addfreelicense\/(\d+)/i) ||
          markup.match(/name=["']subid["'][^>]*value=["'](\d+)/i);
        if (match) subId = String(match[1]);
      }

      if (subId) break;
    }

    await sleep(500);
  }

  if (!giveawayBlock) {
    return { status: 'promotion_unavailable', message: 'Steam не показывает активный блок Free to keep для этой игры.' };
  }
  if (!subId) {
    return { status: 'package_missing', message: 'Раздача найдена, но Dropwave не смог определить Steam Package ID (SubID).' };
  }

  const sessionId = String(window.g_sessionID || '');
  if (!sessionId) {
    return { status: 'login_required', message: 'Steam Store не выдал sessionid. Обновите вход в Steam и повторите.' };
  }

  const postLicense = async (url) => {
    const body = new URLSearchParams({ ajax: 'true', sessionid: sessionId });
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString()
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  };

  let request = await postLicense(`/freelicense/addfreelicense/${encodeURIComponent(subId)}`);
  if (!request.ok && (request.status === 404 || request.status === 405)) {
    request = await postLicense(`/checkout/addfreelicense/${encodeURIComponent(subId)}`);
  }

  if (!request.ok) {
    return { status: 'error', message: `Steam отклонил запрос бесплатной лицензии: HTTP ${request.status}.`, subId };
  }

  let purchaseDetail = null;
  try {
    const parsed = JSON.parse(request.text || 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.purchaseresultdetail != null) {
      purchaseDetail = Number(parsed.purchaseresultdetail);
    }
  } catch (_) {}

  // Даем dynamicstore обновиться, затем проверяем именно AppID/PackageID.
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? 900 : 500);
    if (await ownsApp(subId)) {
      return { status: 'success', message: 'Steam подтвердил добавление игры в библиотеку.', subId };
    }
  }

  // У Steam код 9 обычно означает, что продукт уже доступен аккаунту.
  if (purchaseDetail === 9 || purchaseDetail === 0 || /^\s*\[\s*\]\s*$/.test(request.text || '')) {
    return {
      status: 'pending',
      message: 'Steam принял запрос, но владение ещё не подтверждено. Dropwave повторит проверку при следующем поиске.',
      subId
    };
  }

  return {
    status: 'uncertain',
    message: purchaseDetail == null
      ? 'Steam принял запрос, но Dropwave не смог подтвердить лицензию по ответу.'
      : `Steam вернул код результата ${purchaseDetail}; получение не подтверждено.`,
    subId,
    purchaseResultDetail: purchaseDetail
  };
}

// Ограниченный локальный журнал. Очередь записи не допускает потерь событий
// от двух последовательных/параллельных попыток и очистки журнала.
function queueJournalWrite(operation) {
  const next = journalWriteQueue.then(operation);
  journalWriteQueue = next.catch(() => {});
  return next;
}

async function saveLastClaimResult(game, result, source, accountId = '') {
  const payload = {
    appId: String(game.appId),
    title: String(game.title || '').slice(0, 200),
    status: String(result?.status || 'unknown'),
    message: String(result?.message || '').slice(0, 500),
    source: source === 'auto' ? 'auto' : 'manual',
    accountId: String(accountId || ''),
    at: Date.now()
  };
  await queueJournalWrite(async () => {
    const state = await chrome.storage.local.get('claimJournal');
    const journal = Array.isArray(state.claimJournal) ? state.claimJournal : [];
    journal.unshift(payload);
    await chrome.storage.local.set({
      lastClaimResult: payload,
      claimJournal: journal.slice(0, CLAIM_JOURNAL_LIMIT)
    });
  });
}

async function clearCurrentAccountJournal() {
  await queueJournalWrite(async () => {
    const state = await chrome.storage.local.get(['claimJournal', 'activeSteamAccountId']);
    const accountId = String(state.activeSteamAccountId || '');
    const journal = Array.isArray(state.claimJournal) ? state.claimJournal : [];
    await chrome.storage.local.set({
      claimJournal: journal.filter((item) => String(item?.accountId || '') !== accountId)
    });
  });
}

function createBackgroundTabCompat(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(tab);
    });
  });
}

function removeTabCompat(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve();
    });
  });
}

function getTabCompat(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(tab);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timer) clearTimeout(timer);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(() => fail(new Error('Steam слишком долго загружает страницу')), timeoutMs);

    try {
      const tab = await getTabCompat(tabId);
      if (tab && tab.status === 'complete') done();
    } catch (error) {
      fail(error);
    }
  });
}

async function waitForTabCompleteIfLoading(tabId, timeoutMs) {
  try {
    const tab = await getTabCompat(tabId);
    if (tab && tab.status === 'loading') await waitForTabComplete(tabId, timeoutMs);
  } catch (_) {
    // Если вкладка успела перейти/закрыться, последующая проверка вернёт понятную ошибку.
  }
}

function executeScriptCompat(tabId, func) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func
    }, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(results || []);
    });
  });
}

function executeScriptWithArgsCompat(tabId, func, args) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: Array.isArray(args) ? args : []
    }, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(results || []);
    });
  });
}

function executeScriptMainCompat(tabId, func) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func
    }, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(results || []);
    });
  });
}

function executeScriptWithArgsMainCompat(tabId, func, args) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args: Array.isArray(args) ? args : []
    }, (results) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(results || []);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstGroup(text, regex) {
  const match = String(text || '').match(regex);
  return match ? match[1] : '';
}

function cleanText(value) {
  return decodeHtml(String(value || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/gi, '/');
}

function safeSteamUrl(value) {
  try {
    const url = new URL(value, 'https://store.steampowered.com/');
    if (url.protocol !== 'https:' || url.hostname !== 'store.steampowered.com') return '';
    return url.toString();
  } catch {
    return '';
  }
}

async function showGameNotification(game) {
  const notificationId = `steam-free-app-${game.appId}`;

  const state = await chrome.storage.local.get('notificationTargets');
  const targets = state.notificationTargets && typeof state.notificationTargets === 'object'
    ? state.notificationTargets
    : {};
  targets[notificationId] = game.url;

  const ids = Object.keys(targets);
  if (ids.length > 100) {
    for (const id of ids.slice(0, ids.length - 100)) delete targets[id];
  }
  await chrome.storage.local.set({ notificationTargets: targets });

  const remaining = formatRemainingForNotification(game.endAt);
  const messageLines = [
    game.title,
    `${game.originalPrice} → ${game.finalPrice}`
  ];
  if (remaining) messageLines.push(remaining);
  messageLines.push('Нажмите на уведомление, чтобы открыть Steam.');

  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Steam: игра временно бесплатна',
    message: messageLines.join('\n'),
    contextMessage: 'Скидка 100%',
    requireInteraction: true
  });
}


async function showAutoClaimNotification(game, result) {
  const notificationId = `steam-free-app-${game.appId}`;
  const state = await chrome.storage.local.get('notificationTargets');
  const targets = state.notificationTargets && typeof state.notificationTargets === 'object'
    ? state.notificationTargets
    : {};
  targets[notificationId] = game.url;
  const ids = Object.keys(targets);
  if (ids.length > 100) {
    for (const id of ids.slice(0, ids.length - 100)) delete targets[id];
  }
  await chrome.storage.local.set({ notificationTargets: targets });

  let title = 'Dropwave: новая бесплатная игра';
  let message = `${game.title}\n${result.message || 'Автополучение завершено.'}`;

  if (result.status === 'success') {
    title = 'Dropwave: игра добавлена в библиотеку';
  } else if (result.status === 'already_owned') {
    title = 'Dropwave: игра уже в библиотеке';
  } else if (result.status === 'login_required') {
    title = 'Dropwave: требуется вход в Steam';
    message = `${game.title}\nВойдите в Steam Store в этом браузере, чтобы автополучение работало. Авторизации только в Steam Community недостаточно.`;
  } else if (result.status === 'age_required') {
    title = 'Dropwave: Steam требует подтверждение';
    message = `${game.title}\nSteam просит подтвердить возраст на странице игры.`;
  } else if (result.status === 'pending' || result.status === 'uncertain') {
    title = 'Dropwave: результат не подтверждён';
  } else if (result.status === 'error' || result.status === 'package_missing' ||
             result.status === 'promotion_unavailable' || result.status === 'identity_unknown') {
    title = 'Dropwave: не удалось забрать игру';
  }

  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    requireInteraction: result.status !== 'success' && result.status !== 'already_owned'
  });
}

function formatRemainingForNotification(endAt) {
  const end = Number(endAt);
  if (!end || end <= Date.now()) return '';
  const minutes = Math.max(1, Math.floor((end - Date.now()) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `До конца: ${days} д. ${hours} ч.`;
  if (hours > 0) return `До конца: ${hours} ч. ${minutes % 60} мин.`;
  return `До конца: ${minutes} мин.`;
}

async function openNotificationTarget(notificationId) {
  let targetUrl = '';

  if (notificationId === 'steam-free-summary') {
    targetUrl = SEARCH_URL;
  } else {
    const state = await chrome.storage.local.get('notificationTargets');
    const targets = state.notificationTargets && typeof state.notificationTargets === 'object'
      ? state.notificationTargets
      : {};

    targetUrl = targets[notificationId] || '';

    if (!targetUrl) {
      const match = notificationId.match(/^steam-free-app-(\d+)$/);
      if (match) targetUrl = `https://store.steampowered.com/app/${match[1]}/`;
    }
  }

  const url = safeSteamUrl(targetUrl);
  if (!url) return;

  try {
    await createTabCompat(url);
    try {
      await clearNotificationCompat(notificationId);
    } catch (_) {
      // Открытие страницы важнее очистки уведомления.
    }
  } catch (firstError) {
    const tabs = await queryTabsCompat({ active: true, lastFocusedWindow: true });
    const activeTab = tabs && tabs[0];
    if (!activeTab || typeof activeTab.id !== 'number') throw firstError;
    await updateTabCompat(activeTab.id, url);
  }
}

function createTabCompat(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url, active: true }, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function queryTabsCompat(queryInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tabs || []);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function updateTabCompat(tabId, url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, { url, active: true }, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tab);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function clearNotificationCompat(notificationId) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.clear(notificationId, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

async function updateBadge(count) {
  await chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
  await chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '' });
}

function readableError(error) {
  if (!error) return 'Неизвестная ошибка';
  return error.message || String(error);
}
