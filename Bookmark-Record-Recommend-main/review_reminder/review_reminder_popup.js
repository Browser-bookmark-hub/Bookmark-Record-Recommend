(function () {
  const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;
  const params = new URLSearchParams(window.location.search || '');
  const keys = String(params.get('keys') || '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);

  const state = {
    lang: 'zh_CN',
    items: [],
    totalCount: 0,
    closingAsSkipped: false
  };

  const CARD_ACTIONS = {
    review: 'review',
    postpone: 'postpone',
    skip: 'skip',
    block: 'block'
  };
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const SCORE_DEBUG_CACHE_TTL_MS = 60 * 1000;
  const scoreDebugCache = new Map();
  const scoreDebugInFlight = new Map();

  const text = {
    zh_CN: {
      pluginName: '书签记录与推荐',
      notificationTitle: '待复习提醒',
      note: '同一书签同一到期时间只提醒一次，避免重复骚扰。',
      itemsTitle: '到期书签（同一到期时间只提醒一次）',
      loading: '正在加载...',
      empty: '当前没有到期书签。',
      open: '打开待复习',
      due: '到期',
      oneHourLater: '1小时后',
      skipped: '已跳过',
      blocked: '已屏蔽',
      blockUnavailable: '待复习中的书签暂不支持直接屏蔽',
      actionFailed: '操作失败，请重试',
      reviewing: '已标记复习',
      openFailed: '打开失败，请重试',
      openedNotReviewed: '已打开，但未标记为已复习，请稍后重试',
      close: '关闭',
      iconAlt: '扩展图标',
      debugTitle: '参数',
      debugLoading: '参数加载中...',
      debugLoadFailed: '参数加载失败',
      debugNoData: '暂无参数数据',
      scorePrefix: 'S',
      genericDomain: '未知域名'
    },
    en: {
      pluginName: 'Bookmark Record & Recommend',
      notificationTitle: 'Review Reminder',
      note: 'Each bookmark is shown once for the same due time to avoid repeated interruptions.',
      itemsTitle: 'Due Bookmarks (shown once per due time)',
      loading: 'Loading...',
      empty: 'No due bookmarks right now.',
      open: 'Open Review List',
      due: 'Due',
      oneHourLater: '1h later',
      skipped: 'Skipped',
      blocked: 'Blocked',
      blockUnavailable: 'Cannot block bookmarks that are still in review queue',
      actionFailed: 'Action failed, please retry',
      reviewing: 'Reviewed',
      openFailed: 'Open failed, please retry',
      openedNotReviewed: 'Opened, but not marked as reviewed yet. Please retry shortly.',
      close: 'Close',
      iconAlt: 'Extension icon',
      debugTitle: 'Debug',
      debugLoading: 'Loading debug...',
      debugLoadFailed: 'Debug load failed',
      debugNoData: 'No debug data',
      scorePrefix: 'S',
      genericDomain: 'Unknown domain'
    }
  };

  applyInitialPopupTheme();

  function t(key) {
    return text[state.lang][key] || text.zh_CN[key] || key;
  }

  function applyInitialPopupTheme() {
    try {
      const hasOverride = localStorage.getItem('historyViewerHasCustomTheme') === 'true';
      const override = hasOverride ? String(localStorage.getItem('historyViewerCustomTheme') || '').trim().toLowerCase() : '';
      const prefersDark = typeof window !== 'undefined'
        && window.matchMedia
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = override === 'dark' || override === 'light'
        ? override
        : (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    } catch (_) {}
  }

  function setCopy() {
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
    document.getElementById('pluginName').textContent = t('pluginName');
    document.getElementById('notificationTitle').textContent = t('notificationTitle');
    document.getElementById('itemsTitle').textContent = t('itemsTitle');
    document.getElementById('loadingText').textContent = t('loading');
    document.getElementById('openReviewBtn').textContent = t('open');
    const closeBtn = document.getElementById('closeBtn');
    if (closeBtn) closeBtn.setAttribute('aria-label', t('close'));
    const icon = document.querySelector('.notification-icon');
    if (icon) icon.setAttribute('alt', t('iconAlt'));
    document.title = t('notificationTitle');
  }

  function detectDefaultLang() {
    try {
      const ui = String(browserAPI?.i18n?.getUILanguage?.() || navigator.language || '').toLowerCase();
      return ui.startsWith('zh') ? 'zh_CN' : 'en';
    } catch (_) {
      return 'en';
    }
  }

  async function resolvePopupLanguage() {
    try {
      const hasOverride = localStorage.getItem('historyViewerHasCustomLang') === 'true';
      const override = String(localStorage.getItem('historyViewerCustomLang') || '').trim();
      if (hasOverride && (override === 'zh_CN' || override === 'en')) {
        state.lang = override;
        return;
      }
    } catch (_) {}

    try {
      const result = await new Promise((resolve) => {
        try {
          browserAPI.storage.local.get(['preferredLang'], (payload) => {
            resolve(payload || {});
          });
        } catch (_) {
          resolve({});
        }
      });
      const preferredLang = String(result?.preferredLang || '').trim();
      if (preferredLang === 'zh_CN' || preferredLang === 'en') {
        state.lang = preferredLang;
        return;
      }
    } catch (_) {}

    state.lang = detectDefaultLang();
  }

  function setActionFeedback(message = '', tone = '') {
    const el = document.getElementById('actionFeedback');
    if (!el) return;
    const textContent = String(message || '').trim();
    if (!textContent) {
      el.hidden = true;
      el.textContent = '';
      el.classList.remove('is-success', 'is-error');
      return;
    }
    el.hidden = false;
    el.textContent = textContent;
    el.classList.toggle('is-success', tone === 'success');
    el.classList.toggle('is-error', tone === 'error');
  }

  function getCurrentTheme() {
    return new Promise((resolve) => {
      try {
        const hasOverride = localStorage.getItem('historyViewerHasCustomTheme') === 'true';
        const override = hasOverride ? String(localStorage.getItem('historyViewerCustomTheme') || '').trim().toLowerCase() : '';
        if (override === 'dark' || override === 'light') {
          resolve(override);
          return;
        }
        browserAPI.storage.local.get(['currentTheme'], (result) => {
          const stored = String(result?.currentTheme || '').trim().toLowerCase();
          if (stored === 'dark' || stored === 'light') {
            resolve(stored);
            return;
          }
          const prefersDark = typeof window !== 'undefined'
            && window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
          resolve(prefersDark ? 'dark' : 'light');
        });
      } catch (_) {
        const prefersDark = typeof window !== 'undefined'
          && window.matchMedia
          && window.matchMedia('(prefers-color-scheme: dark)').matches;
        resolve(prefersDark ? 'dark' : 'light');
      }
    });
  }

  async function applyPopupTheme() {
    const theme = await getCurrentTheme();
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        browserAPI.runtime.sendMessage(message, (response) => {
          if (browserAPI.runtime?.lastError) {
            resolve({ success: false, error: browserAPI.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false });
        });
      } catch (error) {
        resolve({ success: false, error: error?.message || String(error) });
      }
    });
  }

  function normalizeReminderKeys(value) {
    if (Array.isArray(value)) {
      return value.map(item => String(item || '').trim()).filter(Boolean);
    }
    const single = String(value || '').trim();
    return single ? [single] : [];
  }

  function toPriorityValue(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : Number.NaN;
  }

  function getItemPriority(item) {
    const direct = toPriorityValue(item?.priority);
    if (Number.isFinite(direct)) return direct;
    return toPriorityValue(item?.score);
  }

  function formatPriority(value) {
    if (!Number.isFinite(value)) return `${t('scorePrefix')} = --`;
    return `${t('scorePrefix')} = ${value.toFixed(2)}`;
  }

  function formatHost(url) {
    try {
      return new URL(url).hostname || t('genericDomain');
    } catch (_) {
      return url || t('genericDomain');
    }
  }

  function applyCardDisabledState(card, disabled) {
    const target = card;
    if (!target) return;
    target.classList.toggle('is-busy', disabled === true);
    target.querySelectorAll('button').forEach((btn) => {
      btn.disabled = disabled === true;
    });
  }

  function attachInstantTooltip(element, text) {
    if (!element) return;
    const tipText = String(text || '').trim();
    if (!tipText) return;
    element.dataset.tooltip = tipText;
    element.setAttribute('aria-label', tipText);
  }

  function formatDebugText(debug) {
    if (!debug || typeof debug !== 'object') return t('debugNoData');
    const factors = debug.factors || {};
    const weights = debug.weightsUsed || {};
    const history = debug.matches?.history || {};
    const tracking = debug.matches?.tracking || {};
    const raw = debug.raw || {};
    const score = Number(factors.S);
    const fmt = (value, digits = 3) => {
      const num = Number(value);
      return Number.isFinite(num) ? num.toFixed(digits) : '--';
    };
    const fmtInt = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? String(Math.round(num)) : '--';
    };
    const lines = [
      `${t('scorePrefix')} = ${fmt(score)}`,
      `F=${fmt(factors.F)} C=${fmt(factors.C)} T=${fmt(factors.T)} D=${fmt(factors.D)} L=${fmt(factors.L)} R=${fmt(factors.R)}`,
      `w: ${fmt(weights.w1)} ${fmt(weights.w2)} ${fmt(weights.w3)} ${fmt(weights.w4)} ${fmt(weights.w5)}`,
      `history: ${history.type || 'none'} / vc=${fmtInt(history.visitCount)}`,
      `tracking: ${tracking.type || 'none'} / min=${fmt(raw.compositeMinutes, 2)}`
    ];
    return lines.join('\n');
  }

  function getCachedScoreDebug(bookmarkId) {
    const key = String(bookmarkId || '').trim();
    if (!key) return null;
    const entry = scoreDebugCache.get(key);
    if (!entry) return null;
    if ((Date.now() - Number(entry.time || 0)) > SCORE_DEBUG_CACHE_TTL_MS) {
      scoreDebugCache.delete(key);
      return null;
    }
    return entry.debug || null;
  }

  function setCachedScoreDebug(bookmarkId, debug) {
    const key = String(bookmarkId || '').trim();
    if (!key || !debug) return;
    scoreDebugCache.set(key, {
      time: Date.now(),
      debug
    });
  }

  async function requestScoreDebug(bookmarkId) {
    const key = String(bookmarkId || '').trim();
    if (!key) return null;
    const inFlight = scoreDebugInFlight.get(key);
    if (inFlight) return inFlight;

    const requestPromise = sendMessage({
      action: 'getBookmarkScoreDebug',
      bookmarkId: key
    }).then((response) => {
      if (!response?.success || !response?.debug) return null;
      setCachedScoreDebug(key, response.debug);
      return response.debug;
    }).catch(() => null).finally(() => {
      scoreDebugInFlight.delete(key);
    });

    scoreDebugInFlight.set(key, requestPromise);
    return requestPromise;
  }

  function createItem(item) {
    const row = document.createElement('article');
    row.className = 'reminder-card';
    row.dataset.url = item.url || '';
    row.dataset.title = item.title || '';
    row.dataset.bookmarkId = item.bookmarkId || '';
    row.dataset.reminderKey = item.reminderKey || '';
    row.dataset.priority = Number.isFinite(getItemPriority(item))
      ? String(getItemPriority(item))
      : '';

    const badge = document.createElement('span');
    badge.className = 'card-due-badge';
    badge.textContent = t('due');

    const debugButton = document.createElement('button');
    debugButton.className = 'card-debug-btn';
    debugButton.type = 'button';
    debugButton.dataset.action = 'debug';
    debugButton.title = t('debugTitle');
    debugButton.setAttribute('aria-label', t('debugTitle'));
    debugButton.innerHTML = '<i class="fas fa-info-circle"></i>';

    const debugOverlay = document.createElement('div');
    debugOverlay.className = 'recommend-debug';
    debugOverlay.setAttribute('aria-hidden', 'true');
    debugOverlay.innerHTML = `
      <div class="recommend-debug-header">
        <span>${t('debugTitle')}</span>
        <button class="recommend-debug-close-btn" type="button" aria-label="${t('close')}">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <div class="recommend-debug-body">
        <pre class="recommend-debug-pre">${t('debugLoading')}</pre>
      </div>
    `;

    const favicon = document.createElement('img');
    favicon.className = 'card-favicon';
    favicon.alt = '';
    favicon.src = item.url
      ? browserAPI.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(item.url)}&size=32`)
      : '../icons/icon48.png';
    favicon.onerror = () => {
      favicon.onerror = null;
      favicon.src = '../icons/icon48.png';
    };

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.title || item.url || '';

    const url = document.createElement('div');
    url.className = 'card-url';
    url.textContent = formatHost(item.url || '');

    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const priority = document.createElement('span');
    priority.className = 'card-priority';
    priority.textContent = formatPriority(getItemPriority(item));

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const btnLater = document.createElement('button');
    btnLater.className = 'card-btn card-btn-later';
    btnLater.type = 'button';
    btnLater.dataset.action = CARD_ACTIONS.postpone;
    attachInstantTooltip(btnLater, t('oneHourLater'));
    btnLater.innerHTML = '<i class="fas fa-clock"></i>';

    const btnSkip = document.createElement('button');
    btnSkip.className = 'card-btn card-btn-skip';
    btnSkip.type = 'button';
    btnSkip.dataset.action = CARD_ACTIONS.skip;
    attachInstantTooltip(btnSkip, t('skipped'));
    btnSkip.innerHTML = '<i class="fas fa-forward"></i>';

    const btnBlock = document.createElement('button');
    btnBlock.className = 'card-btn card-btn-block';
    btnBlock.type = 'button';
    btnBlock.dataset.action = CARD_ACTIONS.block;
    attachInstantTooltip(btnBlock, t('blocked'));
    btnBlock.innerHTML = '<i class="fas fa-ban"></i>';

    actions.append(btnLater, btnSkip, btnBlock);
    footer.append(priority, actions);

    row.append(badge, debugButton, debugOverlay, favicon, title, url, footer);
    return row;
  }

  function render() {
    const list = document.getElementById('itemsList');
    const count = document.getElementById('itemsCount');
    const openBtn = document.getElementById('openReviewBtn');
    list.textContent = '';
    count.textContent = String(state.totalCount || state.items.length);
    openBtn.disabled = state.totalCount === 0 && state.items.length === 0;
    list.classList.toggle('single-card', state.items.length === 1);

    if (state.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'state-message';
      empty.textContent = t('empty');
      list.appendChild(empty);
      setActionFeedback('', '');
      return;
    }

    for (const item of state.items) {
      list.appendChild(createItem(item));
    }
  }

  async function load() {
    const response = await sendMessage({
      action: 'getReviewReminderPopupPayload',
      keys
    });
    state.items = Array.isArray(response?.items) ? response.items : [];
    state.totalCount = Math.max(
      state.items.length,
      Number(response?.totalCount || 0)
    );
    if (state.items.length === 0) {
      await sendMessage({ action: 'dismissEmptyReviewReminderPopup' });
      window.close();
      return;
    }
    render();
  }

  function removeCardByBookmarkId(bookmarkId) {
    const id = String(bookmarkId || '').trim();
    if (!id) return false;
    const index = state.items.findIndex(item => String(item?.bookmarkId || '').trim() === id);
    if (index < 0) return false;
    state.items.splice(index, 1);
    render();
    return true;
  }

  async function openReviewList() {
    document.getElementById('openReviewBtn').disabled = true;
    await sendMessage({
      action: 'openReviewReminderTarget',
      keys,
      focusPostponedArchive: true
    });
    window.close();
  }

  async function closeAsSkipped() {
    if (state.closingAsSkipped) return;
    state.closingAsSkipped = true;
    const closeBtn = document.getElementById('closeBtn');
    if (closeBtn) closeBtn.disabled = true;
    const items = Array.isArray(state.items) ? [...state.items] : [];
    await Promise.all(items.map((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      if (!bookmarkId) return Promise.resolve(null);
      return sendMessage({
        action: 'executeReviewReminderCardAction',
        recommendAction: CARD_ACTIONS.skip,
        bookmarkId,
        keys: normalizeReminderKeys(item?.reminderKey),
        timestamp: Date.now()
      });
    }));
    window.close();
  }

  async function executeCardAction(card, actionType) {
    const bookmarkId = String(card?.dataset?.bookmarkId || '').trim();
    if (!bookmarkId || !actionType) return false;
    const reminderKeys = normalizeReminderKeys(card?.dataset?.reminderKey);
    applyCardDisabledState(card, true);
    try {
      const response = await sendMessage({
        action: 'executeReviewReminderCardAction',
        recommendAction: actionType,
        bookmarkId,
        keys: reminderKeys,
        delayMs: actionType === CARD_ACTIONS.postpone ? ONE_HOUR_MS : undefined,
        scope: actionType === CARD_ACTIONS.block ? 'sameTitle' : undefined,
        timestamp: Date.now()
      });
      if (!response?.success) {
        setActionFeedback(t('actionFailed'), 'error');
        return false;
      }

      if (actionType === CARD_ACTIONS.block && Number(response?.blockedBookmarkIds?.length || 0) === 0) {
        setActionFeedback(t('blockUnavailable'), 'error');
        return false;
      }

      if (actionType === CARD_ACTIONS.skip) {
        setActionFeedback(t('skipped'), 'success');
      } else if (actionType === CARD_ACTIONS.block) {
        setActionFeedback(t('blocked'), 'success');
      } else if (actionType === CARD_ACTIONS.postpone) {
        setActionFeedback(t('oneHourLater'), 'success');
      } else {
        setActionFeedback(t('reviewing'), 'success');
      }
      removeCardByBookmarkId(bookmarkId);
      if (state.items.length === 0) window.close();
      return true;
    } finally {
      applyCardDisabledState(card, false);
    }
  }

  function closeCardDebug(card) {
    if (!card) return;
    card.classList.remove('debug-open');
    const overlay = card.querySelector('.recommend-debug');
    if (overlay) overlay.setAttribute('aria-hidden', 'true');
  }

  async function openCardDebug(card) {
    if (!card) return;
    const bookmarkId = String(card.dataset.bookmarkId || '').trim();
    const debugPre = card.querySelector('.recommend-debug-pre');
    const overlay = card.querySelector('.recommend-debug');
    if (!bookmarkId || !debugPre || !overlay) return;

    card.classList.add('debug-open');
    overlay.setAttribute('aria-hidden', 'false');

    const cached = getCachedScoreDebug(bookmarkId);
    if (cached) {
      debugPre.textContent = formatDebugText(cached);
      return;
    }

    debugPre.textContent = t('debugLoading');
    const debug = await requestScoreDebug(bookmarkId);
    if (!debug) {
      debugPre.textContent = t('debugLoadFailed');
      return;
    }
    debugPre.textContent = formatDebugText(debug);
  }

  function updateCardPriorityFromDebug(card, debug) {
    if (!card || !debug) return;
    const score = Number(debug?.storage?.cachedEntry?.S ?? debug?.factors?.S);
    if (!Number.isFinite(score)) return;
    const priorityEl = card.querySelector('.card-priority');
    if (priorityEl) {
      priorityEl.textContent = formatPriority(score);
    }
  }

  async function warmupVisibleCardScores() {
    const cards = Array.from(document.querySelectorAll('.reminder-card'));
    if (cards.length === 0) return;
    await Promise.all(cards.map(async (card) => {
      const bookmarkId = String(card.dataset.bookmarkId || '').trim();
      if (!bookmarkId) return;
      const cached = getCachedScoreDebug(bookmarkId);
      if (cached) {
        updateCardPriorityFromDebug(card, cached);
        return;
      }
      const debug = await requestScoreDebug(bookmarkId);
      if (debug) {
        updateCardPriorityFromDebug(card, debug);
      }
    }));
  }

  async function openBookmarkFromCard(card) {
    const url = String(card?.dataset?.url || '').trim();
    if (!url) return;
    const reminderKeys = normalizeReminderKeys(card?.dataset?.reminderKey);
    const response = await sendMessage({
      action: 'openReviewReminderBookmark',
      url,
      title: card.dataset.title || '',
      bookmarkId: card.dataset.bookmarkId || '',
      keys: reminderKeys
    });
    if (!response?.success) {
      if (response?.opened === true) {
        setActionFeedback(t('openedNotReviewed'), 'error');
        return;
      }
      setActionFeedback(t('openFailed'), 'error');
      return;
    }
    if (response?.reviewHandled === false) {
      setActionFeedback(t('openedNotReviewed'), 'error');
      return;
    }
    setActionFeedback(t('reviewing'), 'success');
    removeCardByBookmarkId(card.dataset.bookmarkId);
    if (state.items.length === 0) window.close();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    applyPopupTheme().catch(() => {});
    await resolvePopupLanguage();
    setCopy();
    document.getElementById('closeBtn').addEventListener('click', () => {
      closeAsSkipped().catch(() => window.close());
    });
    document.getElementById('openReviewBtn').addEventListener('click', openReviewList);
    document.getElementById('itemsList').addEventListener('click', (event) => {
      const actionButton = event.target.closest('.card-btn');
      if (actionButton) {
        event.preventDefault();
        event.stopPropagation();
        const card = actionButton.closest('.reminder-card');
        if (!card) return;
        executeCardAction(card, actionButton.dataset.action || '').catch(() => {
          setActionFeedback(t('actionFailed'), 'error');
        });
        return;
      }

      const debugButton = event.target.closest('.card-debug-btn');
      if (debugButton) {
        event.preventDefault();
        event.stopPropagation();
        const card = debugButton.closest('.reminder-card');
        if (!card) return;
        if (card.classList.contains('debug-open')) {
          closeCardDebug(card);
        } else {
          openCardDebug(card).catch(() => {
            const debugPre = card.querySelector('.recommend-debug-pre');
            if (debugPre) debugPre.textContent = t('debugLoadFailed');
          });
        }
        return;
      }

      const debugClose = event.target.closest('.recommend-debug-close-btn');
      if (debugClose) {
        event.preventDefault();
        event.stopPropagation();
        const card = debugClose.closest('.reminder-card');
        if (card) closeCardDebug(card);
        return;
      }

      if (event.target.closest('.recommend-debug')) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const card = event.target.closest('.reminder-card');
      if (card) {
        openBookmarkFromCard(card).catch(() => {
          setActionFeedback(t('openFailed'), 'error');
        });
      }
    });
    load().then(() => warmupVisibleCardScores()).catch(() => {});
  });
})();
