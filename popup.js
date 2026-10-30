const SEARCH_URL = 'https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1';
const ALLOWED_INTERVALS = [6, 12, 24];

const els = {
  lastCheck: document.getElementById('lastCheck'),
  gamesCount: document.getElementById('gamesCount'),
  nextCheck: document.getElementById('nextCheck'),
  gamesList: document.getElementById('gamesList'),
  emptyState: document.getElementById('emptyState'),
  historyList: document.getElementById('historyList'),
  historyEmpty: document.getElementById('historyEmpty'),
  historyCount: document.getElementById('historyCount'),
  historyStats: document.getElementById('historyStats'),
  journalTab: document.getElementById('journalTab'),
  journalSection: document.getElementById('journalSection'),
  journalList: document.getElementById('journalList'),
  journalCount: document.getElementById('journalCount'),
  journalEmpty: document.getElementById('journalEmpty'),
  journalSummary: document.getElementById('journalSummary'),
  clearJournalBtn: document.getElementById('clearJournalBtn'),
  errorBox: document.getElementById('errorBox'),
  noticeBox: document.getElementById('noticeBox'),
  checkBtn: document.getElementById('checkBtn'),
  checkBtnText: document.getElementById('checkBtnText'),
  autoCheck: document.getElementById('autoCheck'),
  autoCheckText: document.getElementById('autoCheckText'),
  autoClaim: document.getElementById('autoClaim'),
  autoClaimText: document.getElementById('autoClaimText'),
  intervalSelect: document.getElementById('intervalSelect'),
  openSearchBtn: document.getElementById('openSearchBtn'),
  currentTab: document.getElementById('currentTab'),
  historyTab: document.getElementById('historyTab'),
  currentSection: document.getElementById('currentSection'),
  historySection: document.getElementById('historySection'),
  steamLoginBtn: document.getElementById('steamLoginBtn'),
  steamSessionCard: document.getElementById('steamSessionCard'),
  steamSessionDot: document.getElementById('steamSessionDot'),
  steamSessionTitle: document.getElementById('steamSessionTitle'),
  steamSessionText: document.getElementById('steamSessionText'),
  languageSelect: document.getElementById('languageSelect'),
  themeToggle: document.getElementById('themeToggle'),
  themeIcon: document.getElementById('themeIcon')
};

let countdownTimer = null;
let steamSessionStatus = 'checking';
let lastSessionResult = { status: 'checking' };
let currentLanguage = DW_I18N.detect();

function t(phrase, vars) {
  return DW_I18N.t(phrase, currentLanguage, vars);
}

function localizeMessage(phrase) {
  return DW_I18N.message(phrase, currentLanguage);
}

async function initLanguage() {
  const state = await chrome.storage.local.get(['language']);
  currentLanguage = ['ru', 'en'].includes(state.language) ? state.language : DW_I18N.detect();
  applyLanguage();
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage;
  els.languageSelect.value = currentLanguage;
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((element) => {
    element.setAttribute('aria-label', t(element.dataset.i18nAria));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    element.title = t(element.dataset.i18nTitle);
  });
}


init();

async function init() {
  await initTheme();
  await initLanguage();
  await renderState();
  startCountdownRefresh();
  refreshSteamSessionStatus();

  els.checkBtn.addEventListener('click', async () => {
    setBusy(true);
    hideError();
    try {
      const response = await sendMessage({ type: 'CHECK_NOW' });
      if (!response?.ok) throw new Error(response?.error || t('Ошибка проверки'));
      await renderState();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      setBusy(false);
    }
  });

  els.autoCheck.addEventListener('change', async () => {
    const enabled = els.autoCheck.checked;
    const response = await sendMessage({ type: 'SET_AUTO_CHECK', enabled });
    if (!response?.ok) {
      els.autoCheck.checked = !enabled;
      showError(response?.error || t('Не удалось изменить настройку'));
    }
    await renderState();
  });

  els.intervalSelect.addEventListener('change', async () => {
    const hours = Number(els.intervalSelect.value);
    if (!ALLOWED_INTERVALS.includes(hours)) return;

    const response = await sendMessage({ type: 'SET_CHECK_INTERVAL', hours });
    if (!response?.ok) {
      showError(response?.error || t('Не удалось изменить период проверки'));
    }
    await renderState();
  });

  els.autoClaim.addEventListener('change', async () => {
    const enabled = els.autoClaim.checked;
    hideError();
    hideNotice();

    const response = await sendMessage({ type: 'SET_AUTO_CLAIM', enabled });
    if (!response?.ok) {
      els.autoClaim.checked = !enabled;
      showError(response?.error || t('Не удалось изменить автополучение'));
    } else {
      if (response.checkWarning) {
        showError(t('Автополучение включено, но проверка не завершилась: ') + response.checkWarning);
      } else if (enabled && steamSessionStatus === 'login_required') {
        showError(t('Автополучение включено, но Steam Store не авторизован. Нажмите «Войти» в блоке Steam.'));
      } else {
        showNotice(enabled
          ? t('Автополучение включено.')
          : t('Автополучение выключено. Игры можно забирать кнопкой.'));
      }
    }
    await renderState();
  });



  els.steamLoginBtn?.addEventListener('click', async () => {
    hideError();
    hideNotice();

    if (els.steamLoginBtn.dataset.action === 'retry') {
      await refreshSteamSessionStatus();
      return;
    }

    els.steamLoginBtn.disabled = true;
    try {
      const response = await sendMessage({ type: 'OPEN_STEAM_LOGIN' });
      if (!response?.ok) throw new Error(response?.error || t('Не удалось открыть вход Steam Store'));
    } catch (error) {
      showError(error.message || String(error));
      els.steamLoginBtn.disabled = false;
    }
  });

  els.currentTab.addEventListener('click', () => switchTab('current'));
  els.historyTab.addEventListener('click', () => switchTab('history'));
  els.journalTab.addEventListener('click', () => switchTab('journal'));
  els.clearJournalBtn.addEventListener('click', async () => {
    if (!window.confirm(t('Очистить журнал для текущего Steam-аккаунта?'))) return;
    els.clearJournalBtn.disabled = true;
    try {
      const response = await sendMessage({ type: 'CLEAR_JOURNAL' });
      if (!response?.ok) throw new Error(response?.error || t('Не удалось очистить журнал'));
      await renderState();
    } catch (error) {
      showError(error.message || String(error));
    } finally {
      els.clearJournalBtn.disabled = false;
    }
  });

  els.openSearchBtn.addEventListener('click', () => {
    sendMessage({ type: 'OPEN_URL', url: SEARCH_URL });
  });

  els.languageSelect.addEventListener('change', async () => {
    currentLanguage = els.languageSelect.value === 'en' ? 'en' : 'ru';
    await chrome.storage.local.set({ language: currentLanguage });
    applyLanguage();
    setSteamSessionUi(lastSessionResult);
    await renderState();
  });

  els.themeToggle?.addEventListener('change', async () => {
    const theme = els.themeToggle.checked ? 'light' : 'dark';
    applyTheme(theme);
    await chrome.storage.local.set({ theme });
  });

  const watched = new Set(['currentGames', 'history', 'accountClaims', 'activeSteamAccountId',
    'lastSuccess', 'lastError', 'lastAttemptAt', 'checking', 'nextCheckAt', 'autoCheck', 'autoClaim', 'claimJournal']);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((key) => watched.has(key))) {
      renderState().catch(console.error);
    }
  });
}

async function initTheme() {
  const state = await chrome.storage.local.get(['theme']);
  applyTheme(state.theme === 'light' ? 'light' : 'dark');
}

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  if (els.themeToggle) els.themeToggle.checked = light;
  if (els.themeIcon) els.themeIcon.textContent = light ? '☀' : '☾';
}

async function refreshSteamSessionStatus() {
  setSteamSessionUi({ status: 'checking' });
  try {
    const response = await sendMessage({ type: 'CHECK_STEAM_SESSION' });
    if (!response?.ok) throw new Error(response?.error || t('Не удалось проверить Steam Store'));
    setSteamSessionUi(response.result || { status: 'unknown' });
    await renderState();
  } catch (error) {
    setSteamSessionUi({
      status: 'unknown',
      message: error.message || t('Не удалось проверить Steam Store.')
    });
  }
}

function setSteamSessionUi(result) {
  const status = String(result?.status || 'unknown');
  steamSessionStatus = status;
  lastSessionResult = result;

  els.steamSessionCard.className = 'steam-session';
  els.steamLoginBtn.classList.add('hidden');
  els.steamLoginBtn.disabled = false;
  els.steamLoginBtn.dataset.action = 'login';

  if (status === 'checking') {
    els.steamSessionCard.classList.add('checking');
    els.steamSessionTitle.textContent = t('Проверяю Steam Store…');
    els.steamSessionText.textContent = t('Состояние входа в этом браузере');
    return;
  }

  if (status === 'logged_in') {
    els.steamSessionCard.classList.add('logged-in');
    els.steamSessionTitle.textContent = t('Вход выполнен');
    els.steamSessionText.textContent = result.accountName
      ? `${result.accountName} · ${t('Steam Store готов')}`
      : t('Steam Store готов к получению игр');
    return;
  }

  if (status === 'login_required') {
    els.steamSessionCard.classList.add('login-required');
    els.steamSessionTitle.textContent = t('Требуется вход');
    els.steamSessionText.textContent = t('Войдите в Steam Store, чтобы забирать игры');
    els.steamLoginBtn.textContent = t('Войти');
    els.steamLoginBtn.classList.remove('hidden');
    return;
  }

  els.steamSessionCard.classList.add('unknown');
  els.steamSessionTitle.textContent = t('Не удалось проверить вход');
  els.steamSessionText.textContent = localizeMessage(result?.message || t('Повторите проверку Steam Store'));
  els.steamLoginBtn.textContent = t('Повторить');
  els.steamLoginBtn.dataset.action = 'retry';
  els.steamLoginBtn.classList.remove('hidden');
}

async function renderState() {
  const state = await chrome.storage.local.get([
    'autoCheck',
    'autoClaim',
    'checkIntervalHours',
    'currentGames',
    'history',
    'accountClaims',
    'claimJournal',
    'activeSteamAccountId',
    'lastCheck',
    'lastSuccess',
    'lastAttemptAt',
    'lastError',
    'checking',
    'nextCheckAt'
  ]);

  const games = Array.isArray(state.currentGames) ? state.currentGames : [];
  const history = Array.isArray(state.history) ? state.history : [];
  const account = state.accountClaims?.[String(state.activeSteamAccountId || '')] || {};
  const claims = {
    confirmed: new Set((account.confirmed || []).map(String)),
    manual: new Set((account.manual || []).map(String)),
    pending: new Set((account.pending || []).map(String))
  };
  const intervalHours = ALLOWED_INTERVALS.includes(Number(state.checkIntervalHours))
    ? Number(state.checkIntervalHours)
    : 24;

  els.autoCheck.checked = state.autoCheck !== false;
  els.autoClaim.checked = state.autoClaim === true;
  els.autoClaimText.textContent = state.autoClaim === true
    ? t('Включено — забирает при проверках')
    : t('Выключено — забираете кнопкой');
  els.intervalSelect.value = String(intervalHours);
  els.intervalSelect.disabled = state.autoCheck === false;
  els.autoCheckText.textContent = state.autoCheck === false
    ? t('Выключена')
    : `${t('Один раз в')} ${intervalHours} ${pluralHours(intervalHours)}`;

  els.gamesCount.textContent = `${games.length} ${pluralGames(games.length)}`;
  els.historyCount.textContent = history.length ? `(${history.length})` : '';
  const accountId = String(state.activeSteamAccountId || '');
  const journal = (Array.isArray(state.claimJournal) ? state.claimJournal : [])
    .filter((event) => String(event?.accountId || '') === accountId)
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  els.journalCount.textContent = journal.length ? `(${journal.length})` : '';
  const confirmedCount = claims.confirmed.size;
  const manualCount = [...claims.manual].filter((id) => !claims.confirmed.has(id)).length;
  const pendingCount = [...claims.pending].filter((id) => !claims.confirmed.has(id)).length;
  els.historyStats.classList.toggle('hidden', !accountId);
  els.historyStats.textContent = `${t('Получено:')} ${confirmedCount} · ${t('Вручную:')} ${manualCount} · ${t('Ожидает:')} ${pendingCount}`;
  renderJournal(journal, accountId);
  els.lastCheck.textContent = state.lastSuccess
    ? formatDate(state.lastSuccess)
    : t('ещё не было');
  els.nextCheck.textContent = state.autoCheck === false
    ? t('выключена')
    : state.nextCheckAt ? formatNextCheck(state.nextCheckAt) : t('планируется');

  if (state.lastError) showError(localizeMessage(state.lastError)); else hideError();
  renderGames(games, claims);
  renderHistory(history, claims);
}

function renderGames(games, claims) {
  els.gamesList.replaceChildren();
  els.emptyState.classList.toggle('hidden', games.length !== 0);

  for (const game of games) {
    const card = createGameCard(game, getClaimStatus(claims, game.appId), true);
    els.gamesList.appendChild(card);
  }
}

function renderHistory(history, claims) {
  els.historyList.replaceChildren();
  els.historyEmpty.classList.toggle('hidden', history.length !== 0);

  for (const entry of history) {
    const card = document.createElement('article');
    card.className = 'history-card';

    const top = document.createElement('div');
    top.className = 'history-top';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'history-title-wrap';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.title || `App ${entry.appId}`;
    title.title = entry.title || '';
    titleWrap.appendChild(title);

    const badges = document.createElement('div');
    badges.className = 'history-badges';

    const status = document.createElement('span');
    status.className = entry.isActive ? 'status-chip active' : 'status-chip ended';
    status.textContent = entry.isActive ? t('Активна') : t('Завершена');
    badges.appendChild(status);

    const claimStatus = getClaimStatus(claims, entry.appId);
    if (claimStatus !== 'none') {
      const claimedChip = document.createElement('span');
      claimedChip.className = 'status-chip claimed';
      claimedChip.textContent = claimStatus === 'confirmed' ? t('В библиотеке ✓')
        : claimStatus === 'pending' ? t('Ждёт подтверждения') : t('Отмечено вручную');
      badges.appendChild(claimedChip);
    }

    titleWrap.appendChild(badges);
    top.appendChild(titleWrap);
    card.appendChild(top);

    const info = document.createElement('div');
    info.className = 'history-info';
    info.appendChild(historyLine(t('Было'), entry.originalPrice || '—'));
    info.appendChild(historyLine(t('Обнаружена'), entry.firstSeenAt ? formatDateLong(entry.firstSeenAt) : '—'));

    if (entry.endAt) {
      info.appendChild(historyLine(t('Окончание'), formatDateLong(entry.endAt)));
    } else if (!entry.isActive && entry.endedDetectedAt) {
      info.appendChild(historyLine(t('Не активна с проверки'), formatDateLong(entry.endedDetectedAt)));
    } else {
      info.appendChild(historyLine(t('Окончание'), t('Steam не сообщил срок')));
    }
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const open = document.createElement('button');
    open.className = 'small-action';
    open.type = 'button';
    open.textContent = t('Открыть Steam');
    open.addEventListener('click', () => sendMessage({ type: 'OPEN_URL', url: entry.url }));
    actions.appendChild(open);

    const isManuallyMarked = claims.manual.has(String(entry.appId));
    const claim = document.createElement('button');
    claim.className = `small-action claim ${isManuallyMarked ? 'is-claimed' : ''}`;
    claim.type = 'button';
    claim.disabled = claimStatus === 'confirmed';
    claim.textContent = claimStatus === 'confirmed' ? t('Подтверждено Steam')
      : isManuallyMarked ? t('Снять отметку') : t('Отметить вручную');
    claim.addEventListener('click', async () => {
      const response = await sendMessage({
        type: 'SET_CLAIMED',
        appId: String(entry.appId),
        claimed: !isManuallyMarked
      });
      if (!response?.ok) showError(response?.error || t('Не удалось сохранить отметку'));
      await renderState();
    });
    actions.appendChild(claim);

    card.appendChild(actions);
    els.historyList.appendChild(card);
  }
}

const CLAIM_JOURNAL_STATUSES = {
  success: ['Получена', 'success'],
  already_owned: ['Уже в библиотеке', 'success'],
  pending: ['Ждёт подтверждения', 'warning'],
  uncertain: ['Не подтверждено', 'warning'],
  login_required: ['Нужен вход', 'warning'],
  age_required: ['Подтвердите возраст', 'warning'],
  busy: ['В процессе', 'warning'],
  error: ['Ошибка', 'danger'],
  identity_unknown: ['Не определён аккаунт', 'danger'],
  package_missing: ['Нет SubID', 'danger'],
  promotion_unavailable: ['Раздача недоступна', 'danger']
};

function renderJournal(events, accountId) {
  els.journalList.replaceChildren();
  els.journalEmpty.classList.toggle('hidden', events.length !== 0);
  els.clearJournalBtn.classList.toggle('hidden', events.length === 0);
  els.journalSummary.textContent = accountId ? t('Операции текущего аккаунта') : t('Операции без определённого аккаунта');
  for (const event of events) {
    const row = document.createElement('article');
    row.className = 'journal-card';
    const head = document.createElement('div');
    head.className = 'journal-head';
    const title = document.createElement('strong');
    title.className = 'journal-title';
    title.textContent = event.title || `App ${event.appId || '—'}`;
    title.title = title.textContent;
    const status = document.createElement('span');
    const [label, type] = CLAIM_JOURNAL_STATUSES[event.status] || [t('Неизвестно'), 'warning'];
    status.className = `journal-status ${type}`;
    status.textContent = t(label);
    head.append(title, status);
    row.appendChild(head);
    const description = document.createElement('div');
    description.className = 'journal-description';
    description.textContent = localizeMessage(event.message || t('Steam не предоставил подробностей.'));
    description.title = description.textContent;
    row.appendChild(description);
    const meta = document.createElement('div');
    meta.className = 'journal-meta';
    const when = Number(event.at) > 0 && Number.isFinite(Number(event.at))
      ? formatDateLong(Number(event.at)) : '—';
    meta.textContent = `${when} · ${event.source === 'auto' ? t('Авто') : t('Вручную')}`;
    row.appendChild(meta);
    els.journalList.appendChild(row);
  }
}

function getClaimStatus(claims, appId) {
  const id = String(appId);
  if (claims.confirmed.has(id)) return 'confirmed';
  if (claims.pending.has(id)) return 'pending';
  if (claims.manual.has(id)) return 'manual';
  return 'none';
}

function createGameCard(game, claimStatus, showCountdown) {
  const card = document.createElement('article');
  card.className = 'game-card';

  if (game.image) {
    const img = document.createElement('img');
    img.className = 'game-image';
    img.src = game.image;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    card.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'game-body';

  const title = document.createElement('div');
  title.className = 'game-title';
  title.textContent = game.title;
  title.title = game.title;
  body.appendChild(title);

  const price = document.createElement('div');
  price.className = 'price-row';

  const pct = document.createElement('span');
  pct.className = 'discount';
  pct.textContent = '-100%';
  price.appendChild(pct);

  const old = document.createElement('span');
  old.className = 'old-price';
  old.textContent = game.originalPrice || '';
  price.appendChild(old);

  const free = document.createElement('span');
  free.className = 'free-price';
  free.textContent = game.finalPrice || 'Free';
  price.appendChild(free);
  body.appendChild(price);

  if (showCountdown) {
    const countdown = document.createElement('div');
    countdown.className = 'countdown';
    if (game.endAt) countdown.dataset.endAt = String(game.endAt);
    countdown.textContent = formatGiveawayTime(game);
    body.appendChild(countdown);
  }

  const claimGameBtn = document.createElement('button');
  const isConfirmed = claimStatus === 'confirmed';
  const isManuallyMarked = claimStatus === 'manual';
  claimGameBtn.className = `open-game claim-game ${isConfirmed ? 'is-claimed' : ''}`;
  claimGameBtn.type = 'button';
  claimGameBtn.disabled = isConfirmed;
  claimGameBtn.textContent = isConfirmed ? t('В библиотеке ✓')
    : claimStatus === 'pending' ? t('Проверить получение повторно') : t('Забрать в библиотеку');
  claimGameBtn.addEventListener('click', async () => {
    hideError();
    hideNotice();
    claimGameBtn.disabled = true;
    claimGameBtn.textContent = t('Добавляю через Steam…');

    let claimResult = null;
    let claimError = null;
    try {
      const response = await sendMessage({
        type: 'CLAIM_GAME',
        game: {
          appId: String(game.appId),
          title: game.title,
          url: game.url
        }
      });
      if (!response?.ok) throw new Error(response?.error || t('Не удалось выполнить получение'));
      claimResult = response.result;
    } catch (error) {
      claimError = error;
    }

    await renderState();
    if (claimError) {
      showError(claimError.message || String(claimError));
    } else {
      showClaimResult(claimResult, game);
    }
  });
  body.appendChild(claimGameBtn);

  const secondary = document.createElement('div');
  secondary.className = 'game-secondary-actions';

  const open = document.createElement('button');
  open.className = 'secondary-game-action';
  open.type = 'button';
  open.textContent = t('Открыть Steam');
  open.addEventListener('click', () => {
    sendMessage({ type: 'OPEN_URL', url: game.url });
  });
  secondary.appendChild(open);

  const claim = document.createElement('button');
  claim.className = `secondary-game-action manual-mark ${isManuallyMarked ? 'is-claimed' : ''}`;
  claim.type = 'button';
  claim.disabled = isConfirmed;
  claim.textContent = isConfirmed ? t('Подтверждено Steam')
    : isManuallyMarked ? t('Снять отметку') : t('Отметить вручную');
  claim.addEventListener('click', async () => {
    const response = await sendMessage({
      type: 'SET_CLAIMED',
      appId: String(game.appId),
      claimed: !isManuallyMarked
    });
    if (!response?.ok) showError(response?.error || t('Не удалось сохранить отметку'));
    await renderState();
  });
  secondary.appendChild(claim);
  body.appendChild(secondary);

  card.appendChild(body);
  return card;
}

function historyLine(label, value) {
  const row = document.createElement('div');
  row.className = 'history-line';
  const left = document.createElement('span');
  left.textContent = label;
  const right = document.createElement('strong');
  right.textContent = value;
  row.append(left, right);
  return row;
}

function switchTab(tab) {
  els.currentTab.classList.toggle('active', tab === 'current');
  els.historyTab.classList.toggle('active', tab === 'history');
  els.journalTab.classList.toggle('active', tab === 'journal');
  els.currentSection.classList.toggle('hidden', tab !== 'current');
  els.historySection.classList.toggle('hidden', tab !== 'history');
  els.journalSection.classList.toggle('hidden', tab !== 'journal');
}

function startCountdownRefresh() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    for (const node of document.querySelectorAll('.countdown[data-end-at]')) {
      const endAt = Number(node.dataset.endAt);
      node.textContent = formatRemaining(endAt);
      node.classList.toggle('ending-soon', endAt > Date.now() && endAt - Date.now() <= 6 * 60 * 60 * 1000);
    }
    refreshNextCheckText();
  }, 30000);
}

async function refreshNextCheckText() {
  const state = await chrome.storage.local.get(['autoCheck', 'nextCheckAt']);
  els.nextCheck.textContent = state.autoCheck === false
    ? t('выключена')
    : state.nextCheckAt ? formatNextCheck(state.nextCheckAt) : t('планируется');
}

function formatGiveawayTime(game) {
  if (game.endAt) return formatRemaining(game.endAt);
  if (game.endText) return `${t('До:')} ${game.endText}`;
  return t('Срок окончания Steam не сообщил');
}

function formatRemaining(endAt) {
  const end = Number(endAt);
  if (!end) return t('Срок окончания Steam не сообщил');
  const diff = end - Date.now();
  if (diff <= 0) return t('Раздача должна была завершиться');

  const totalMinutes = Math.max(1, Math.floor(diff / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${t('До конца:')} ${days} ${t('д.')} ${hours} ${t('ч.')}`;
  if (hours > 0) return `${t('До конца:')} ${hours} ${t('ч.')} ${minutes} ${t('мин.')}`;
  return `${t('До конца:')} ${minutes} ${t('мин.')}`;
}

function setBusy(busy) {
  els.checkBtn.disabled = busy;
  els.checkBtnText.textContent = busy ? t('Проверяю…') : t('Проверить');
}

function showClaimResult(result, game) {
  const status = String(result?.status || 'unknown');
  const title = game?.title || t('Игра');

  if (status === 'success') {
    showNotice(`✓ ${title}: ${t('Steam подтвердил добавление в библиотеку.')}`);
    return;
  }
  if (status === 'already_owned') {
    showNotice(`✓ ${title}: ${t('игра уже находится в вашей библиотеке Steam.')}`);
    return;
  }
  if (status === 'login_required') {
    setSteamSessionUi({ status: 'login_required' });
    showError(t('Требуется вход в Steam Store. Войдите в Steam, чтобы забирать игры.'));
    return;
  }
  if (status === 'age_required') {
    showError(t('Steam просит подтвердить возраст на странице этой игры. Откройте Steam, подтвердите возраст и повторите.'));
    return;
  }
  if (status === 'promotion_unavailable' || status === 'button_missing' || status === 'button_disabled' || status === 'package_missing') {
    showError(result?.message || t('Steam не показывает доступную кнопку Add to Account для этой раздачи.'));
    return;
  }
  if (status === 'busy') {
    showError(result?.message || t('Эта игра уже обрабатывается Dropwave.'));
    return;
  }
  if (status === 'pending') {
    showNotice(result?.message || t('Steam принял запрос. Подтверждение лицензии пока ожидается.'));
    return;
  }
  if (status === 'identity_unknown') {
    showError(result?.message || t('Не удалось достоверно определить Steam-аккаунт.'));
    return;
  }
  if (status === 'uncertain') {
    showError(result?.message || t('Dropwave выполнил действие, но не смог подтвердить добавление. Проверьте библиотеку Steam.'));
    return;
  }
  showError(result?.message || t('Steam не подтвердил получение игры.'));
}

function showError(message) {
  hideNotice();
  els.errorBox.textContent = localizeMessage(message);
  els.errorBox.classList.remove('hidden');
}

function hideError() {
  els.errorBox.textContent = '';
  els.errorBox.classList.add('hidden');
}

function showNotice(message) {
  hideError();
  els.noticeBox.textContent = localizeMessage(message);
  els.noticeBox.classList.remove('hidden');
}

function hideNotice() {
  els.noticeBox.textContent = '';
  els.noticeBox.classList.add('hidden');
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat(currentLanguage === 'en' ? 'en-GB' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function formatDateLong(timestamp) {
  return new Intl.DateTimeFormat(currentLanguage === 'en' ? 'en-GB' : 'ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

function formatNextCheck(timestamp) {
  const diff = Number(timestamp) - Date.now();
  if (diff <= 0) return t('скоро');
  const minutes = Math.max(1, Math.ceil(diff / 60000));
  if (minutes < 60) return `${t('через')} ${minutes} ${t('мин.')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${t('через')} ${hours} ${t('ч.')} ${rest} ${t('мин.')}` : `${t('через')} ${hours} ${t('ч.')}`;
  return formatDate(timestamp);
}

function pluralGames(count) {
  if (currentLanguage === 'en') return Number(count) === 1 ? 'offer' : 'offers';
  const n = Math.abs(Number(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return t('раздач');
  if (n1 === 1) return t('раздача');
  if (n1 >= 2 && n1 <= 4) return t('раздачи');
  return t('раздач');
}

function pluralHours(hours) {
  if (currentLanguage === 'en') return 'hours';
  const n = Number(hours);
  if (n === 24) return 'часа';
  return 'часов';
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}
