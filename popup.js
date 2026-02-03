const browserAPI = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome :
  (typeof browser !== 'undefined' ? browser : null);

const POPUP_RECOMMEND_CARD_COUNT = 3;
const popupRecommendLaterOptionLabels = {
  '3600000': { zh_CN: '1小时后', en: 'In 1 hour' },
  '86400000': { zh_CN: '明天', en: 'Tomorrow' },
  '259200000': { zh_CN: '3天后', en: 'In 3 days' },
  '604800000': { zh_CN: '1周后', en: 'In 1 week' }
};
const popupRecommendTextMap = {
  pageTitle: { zh_CN: '书签推荐 & 记录', en: 'Bookmark Recommend & Records' },
  recommendTitle: { zh_CN: '书签推荐', en: 'Bookmark Recommend' },
  openRecordsBtn: { zh_CN: '记录', en: 'Records' },
  openRecommendBtn: { zh_CN: '推荐', en: 'Recommend' },
  openRecordsTooltip: { zh_CN: '打开书签记录', en: 'Open records' },
  openRecommendTooltip: { zh_CN: '打开推荐页面', en: 'Open recommend' },
  recordsTitle: { zh_CN: '书签记录', en: 'Bookmark Records' },
  refreshSettingsTooltip: { zh_CN: '自动刷新设置', en: 'Refresh settings' },
  refreshText: { zh_CN: '刷新推荐', en: 'Refresh' },
  refreshTooltip: { zh_CN: '刷新推荐', en: 'Refresh' },
  laterTitle: { zh_CN: '稍后提醒', en: 'Remind later' },
  openSourceInfo: { zh_CN: '开源信息', en: 'Open source' },
  openSourceTitle: { zh_CN: '开源信息', en: 'Open source' },
  openSourceGithubLabel: { zh_CN: 'GitHub 仓库:', en: 'GitHub repo:' },
  openSourceIssueLabel: { zh_CN: '问题反馈:', en: 'Issue tracker:' },
  openSourceIssueText: { zh_CN: '提交问题', en: 'Report issue' },
  trackingTitle: { zh_CN: '时间追踪', en: 'Time Tracking' },
  trackingEmpty: { zh_CN: '暂无追踪中的书签', en: 'No active tracking sessions' },
  rankingTitle: { zh_CN: '点击排行', en: 'Click Ranking' },
  rankingEmpty: { zh_CN: '暂无排行数据', en: 'No ranking data' },
  widgetLoading: { zh_CN: '加载中...', en: 'Loading...' },
  rankingRangeHint: {
    zh_CN: { day: '当日', week: '当周', month: '当月', year: '当年', all: '全部' },
    en: { day: 'Today', week: 'This Week', month: 'This Month', year: 'This Year', all: 'All Time' }
  },
  shortcutsTitle: { zh_CN: '快捷键', en: 'Shortcuts' },
  shortcutsRecords: { zh_CN: '打开记录', en: 'Open records' },
  shortcutsRecommend: { zh_CN: '打开推荐', en: 'Open recommend' },
  shortcutsSettings: { zh_CN: '在浏览器中管理快捷键', en: 'Manage shortcuts in browser' },
  shortcutHint: {
    zh_CN: (recordsKey, recommendKey) => `快捷键：推荐 ${recommendKey} / 记录 ${recordsKey}`,
    en: (recordsKey, recommendKey) => `Shortcuts: Recommend ${recommendKey} / Records ${recordsKey}`
  }
};

const DEFAULT_RECOMMEND_REFRESH_SETTINGS = {
  refreshEveryNOpens: 3,
  refreshAfterHours: 0,
  refreshAfterDays: 0,
  lastRefreshTime: 0,
  openCountSinceRefresh: 0
};

const POPUP_SCORE_DEBUG_CACHE_TTL_MS = 60 * 1000;

function detectDefaultLang() {
  try {
    const ui = (browserAPI?.i18n?.getUILanguage?.() || navigator.language || '').toLowerCase();
    return ui.startsWith('zh') ? 'zh_CN' : 'en';
  } catch (_) {}
  return 'en';
}

let popupRecommendLang = detectDefaultLang();
let popupRecommendCards = [];
const popupSkippedBookmarks = new Set();
let popupRecommendLoading = false;
let popupScoresComputeRetryCount = 0;
let popupOpenCountRecorded = false;
let popupLastSaveTime = 0;
let popupCurrentLaterBookmark = null;
const popupFaviconRequestCache = new Map();
const popupScoreDebugCache = new Map();
const popupScoreDebugInFlight = new Map();
let popupShortcuts = { records: 'Alt+4', recommend: 'Alt+5' };
let popupTrackingIntervalId = null;
let popupRankingIntervalId = null;
let popupBookmarkMapCache = { loadedAt: 0, map: new Map() };

async function incrementPopupOpenCount() {
  if (popupOpenCountRecorded) return false;
  popupOpenCountRecorded = true;

  try {
    const result = await new Promise((resolve) => {
      browserAPI.storage.local.get('recommendRefreshSettings', resolve);
    });

    const settings = { ...DEFAULT_RECOMMEND_REFRESH_SETTINGS, ...(result?.recommendRefreshSettings || {}) };
    settings.openCountSinceRefresh = (settings.openCountSinceRefresh || 0) + 1;

    let shouldRefresh = false;
    const now = Date.now();

    if (settings.refreshEveryNOpens > 0 && settings.openCountSinceRefresh >= settings.refreshEveryNOpens) {
      shouldRefresh = true;
    }

    if (!shouldRefresh && settings.refreshAfterHours > 0 && settings.lastRefreshTime > 0) {
      const hoursSinceRefresh = (now - settings.lastRefreshTime) / 3600000;
      if (hoursSinceRefresh >= settings.refreshAfterHours) shouldRefresh = true;
    }

    if (!shouldRefresh && settings.refreshAfterDays > 0 && settings.lastRefreshTime > 0) {
      const daysSinceRefresh = (now - settings.lastRefreshTime) / 86400000;
      if (daysSinceRefresh >= settings.refreshAfterDays) shouldRefresh = true;
    }

    await new Promise((resolve) => {
      browserAPI.storage.local.set({ recommendRefreshSettings: settings }, resolve);
    });

    return shouldRefresh;
  } catch (_) {
    return false;
  }
}

async function markPopupRecommendCardsRefreshed() {
  try {
    const now = Date.now();
    const result = await new Promise((resolve) => {
      browserAPI.storage.local.get('recommendRefreshSettings', resolve);
    });
    const settings = { ...DEFAULT_RECOMMEND_REFRESH_SETTINGS, ...(result?.recommendRefreshSettings || {}) };
    settings.lastRefreshTime = now;
    settings.openCountSinceRefresh = 0;
    await new Promise((resolve) => {
      browserAPI.storage.local.set({ recommendRefreshSettings: settings }, resolve);
    });
  } catch (_) { }
}

function showStatus(text, type = 'info') {
  const statusEl = document.getElementById('statusText');
  if (!statusEl) return;
  statusEl.textContent = text;
  if (type === 'success') statusEl.style.color = 'var(--theme-success-color)';
  else if (type === 'error') statusEl.style.color = 'var(--theme-error-color)';
  else statusEl.style.color = 'var(--theme-text-secondary)';
}

async function safeCreateTab({ url }) {
  if (browserAPI && browserAPI.tabs && browserAPI.tabs.create) {
    return browserAPI.tabs.create({ url });
  }
  window.open(url, '_blank');
}

function getPopupText(key, lang) {
  const entry = popupRecommendTextMap[key];
  if (!entry) return '';
  if (typeof entry === 'function') return entry(lang);
  return entry[lang] || entry.zh_CN || '';
}

function setPreferredLang(lang) {
  popupRecommendLang = lang;
  try {
    localStorage.setItem('preferredLang', lang);
  } catch (_) {}
  if (browserAPI?.storage?.local) {
    browserAPI.storage.local.set({ preferredLang: lang }, () => {});
  }
}

function loadPreferredLang() {
  return new Promise((resolve) => {
    if (!browserAPI?.storage?.local) {
      resolve(detectDefaultLang());
      return;
    }
    browserAPI.storage.local.get(['preferredLang'], (data) => {
      resolve(data.preferredLang || detectDefaultLang());
    });
  });
}

function formatActiveTime(ms) {
  if (!ms || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getRankingRangeLabel(lang, range) {
  const map = popupRecommendTextMap.rankingRangeHint?.[lang] || popupRecommendTextMap.rankingRangeHint.zh_CN;
  return map[range] || map.day;
}

function getRankingRangeConfig(range) {
  const now = new Date();
  const endTime = now.getTime();
  let startTime = 0;
  if (range === 'day') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    startTime = d.getTime();
  } else if (range === 'week') {
    startTime = endTime - 7 * 24 * 3600 * 1000;
  } else if (range === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    startTime = d.getTime();
  } else if (range === 'year') {
    const d = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    startTime = d.getTime();
  } else {
    startTime = 0;
  }
  return { startTime, endTime };
}

async function loadBookmarkUrlMap() {
  const now = Date.now();
  if (popupBookmarkMapCache.loadedAt && (now - popupBookmarkMapCache.loadedAt) < 60 * 1000) {
    return popupBookmarkMapCache.map;
  }
  const map = new Map();
  if (!browserAPI?.bookmarks?.getTree) {
    popupBookmarkMapCache = { loadedAt: now, map };
    return map;
  }
  const tree = await new Promise((resolve) => browserAPI.bookmarks.getTree(resolve));
  const walk = (nodes) => {
    nodes.forEach((node) => {
      if (node.url) {
        map.set(node.url, node.title || node.url);
      }
      if (node.children) walk(node.children);
    });
  };
  if (Array.isArray(tree)) walk(tree);
  popupBookmarkMapCache = { loadedAt: now, map };
  return map;
}

function renderShortcutHint(lang) {
  const hint = document.getElementById('shortcutHint');
  if (!hint) return;
  const formatter = popupRecommendTextMap.shortcutHint?.[lang] || popupRecommendTextMap.shortcutHint.zh_CN;
  hint.textContent = formatter(popupShortcuts.records, popupShortcuts.recommend);
}

function renderShortcutsList(lang) {
  const list = document.getElementById('shortcutsList');
  const title = document.getElementById('shortcutsTitle');
  const settingsBtn = document.getElementById('openShortcutsSettingsBtn');
  if (title) title.textContent = getPopupText('shortcutsTitle', lang);
  if (settingsBtn) settingsBtn.textContent = getPopupText('shortcutsSettings', lang);
  if (!list) return;
  list.innerHTML = '';

  const rowRecommend = document.createElement('div');
  rowRecommend.className = 'shortcuts-row';
  const labelRecommend = document.createElement('span');
  labelRecommend.textContent = getPopupText('shortcutsRecommend', lang);
  const keyRecommend = document.createElement('kbd');
  keyRecommend.textContent = popupShortcuts.recommend;
  rowRecommend.appendChild(labelRecommend);
  rowRecommend.appendChild(keyRecommend);

  const rowRecords = document.createElement('div');
  rowRecords.className = 'shortcuts-row';
  const labelRecords = document.createElement('span');
  labelRecords.textContent = getPopupText('shortcutsRecords', lang);
  const keyRecords = document.createElement('kbd');
  keyRecords.textContent = popupShortcuts.records;
  rowRecords.appendChild(labelRecords);
  rowRecords.appendChild(keyRecords);

  list.appendChild(rowRecommend);
  list.appendChild(rowRecords);
}

function updateOpenSourceText(lang) {
  const openSourceTooltip = document.getElementById('openSourceTooltip');
  if (openSourceTooltip) openSourceTooltip.textContent = getPopupText('openSourceInfo', lang);
  const openSourceTitle = document.getElementById('openSourceInfoTitle');
  if (openSourceTitle) openSourceTitle.textContent = getPopupText('openSourceTitle', lang);
  const openSourceGithubLabel = document.getElementById('openSourceGithubLabel');
  if (openSourceGithubLabel) openSourceGithubLabel.textContent = getPopupText('openSourceGithubLabel', lang);
  const openSourceIssueLabel = document.getElementById('openSourceIssueLabel');
  if (openSourceIssueLabel) openSourceIssueLabel.textContent = getPopupText('openSourceIssueLabel', lang);
  const openSourceIssueText = document.getElementById('openSourceIssueText');
  if (openSourceIssueText) openSourceIssueText.textContent = getPopupText('openSourceIssueText', lang);
}

function schedulePopupListLoading(list, text) {
  if (!list) return null;
  return setTimeout(() => {
    if (list.dataset.renderState === 'data') return;
    list.innerHTML = `<div class="time-tracking-widget-empty"><span>${text}</span></div>`;
    list.dataset.renderState = 'loading';
  }, 200);
}

function setPopupListEmpty(list, text) {
  if (!list) return;
  list.innerHTML = `<div class="time-tracking-widget-empty"><span>${text}</span></div>`;
  list.dataset.renderState = 'empty';
  list.dataset.renderKey = '';
}

function setPopupListData(list, key, build) {
  if (!list) return;
  if (list.dataset.renderKey === key && list.dataset.renderState === 'data') return;
  list.innerHTML = '';
  build();
  list.dataset.renderKey = key;
  list.dataset.renderState = 'data';
}

async function updateTrackingWidget() {
  const list = document.getElementById('popupTrackingList');
  const emptyText = document.getElementById('popupTrackingEmptyText');
  if (!list || !browserAPI?.runtime?.sendMessage) return;
  if (emptyText) emptyText.textContent = getPopupText('trackingEmpty', popupRecommendLang);
  const loadingTimer = schedulePopupListLoading(list, getPopupText('widgetLoading', popupRecommendLang));

  try {
    const response = await browserAPI.runtime.sendMessage({ action: 'getCurrentActiveSessions' });
    if (loadingTimer) clearTimeout(loadingTimer);
    if (!response?.success || !Array.isArray(response.sessions) || response.sessions.length === 0) {
      setPopupListEmpty(list, getPopupText('trackingEmpty', popupRecommendLang));
      return;
    }

    const sessions = response.sessions;
    const grouped = new Map();
    sessions.forEach((session) => {
      const key = session.title || session.url;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(session);
    });

    const displayItems = [];
    grouped.forEach((groupSessions) => {
      const totalMs = groupSessions.reduce((sum, s) => sum + (s.compositeMs || s.activeMs || 0), 0);
      const stateOrder = ['active', 'visible', 'paused', 'background', 'sleeping'];
      const bestState = groupSessions.reduce((best, s) => {
        const bestIdx = stateOrder.indexOf(best);
        const currIdx = stateOrder.indexOf(s.state);
        return currIdx < bestIdx ? s.state : best;
      }, 'sleeping');
      displayItems.push({
        title: groupSessions[0].title,
        url: groupSessions[0].url,
        state: bestState,
        compositeMs: totalMs,
        count: groupSessions.length
      });
    });

    const maxShow = 5;
    const showItems = displayItems.slice(0, maxShow);
    const remaining = displayItems.length - maxShow;
    const renderKey = JSON.stringify({
      showItems: showItems.map(item => ({
        title: item.title || item.url || '',
        url: item.url || '',
        state: item.state || '',
        compositeMs: item.compositeMs || 0,
        count: item.count || 0
      })),
      remaining
    });

    setPopupListData(list, renderKey, () => {
      showItems.forEach((item) => {
        const el = document.createElement('div');
        el.className = 'time-tracking-widget-item';

        const stateIcon = document.createElement('span');
        stateIcon.className = 'item-state';
        stateIcon.textContent = item.state === 'active' ? '🟢'
          : (item.state === 'sleeping' ? '💤'
            : (item.state === 'background' ? '⚪'
              : (item.state === 'visible' ? '🔵' : '🟡')));

        const title = document.createElement('span');
        title.className = 'item-title';
        let titleText = item.title || item.url;
        if (item.count > 1) titleText += ` (${item.count})`;
        title.textContent = titleText;
        title.title = item.title || item.url;

        const time = document.createElement('span');
        time.className = 'item-time';
        time.textContent = formatActiveTime(item.compositeMs);

        el.appendChild(stateIcon);
        el.appendChild(title);
        el.appendChild(time);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          if (item.url) safeCreateTab({ url: item.url });
        });
        list.appendChild(el);
      });

      if (remaining > 0) {
        const moreEl = document.createElement('div');
        moreEl.className = 'time-tracking-widget-more';
        const moreText = popupRecommendLang === 'en'
          ? `+${remaining} more`
          : `还有 ${remaining} 个`;
        moreEl.textContent = moreText;
        list.appendChild(moreEl);
      }
    });
  } catch (_) {
    if (loadingTimer) clearTimeout(loadingTimer);
    setPopupListEmpty(list, getPopupText('trackingEmpty', popupRecommendLang));
  }
}

async function updateRankingWidget() {
  const list = document.getElementById('popupRankingList');
  const hint = document.getElementById('popupRankingHint');
  if (!list || !browserAPI?.history?.search) return;

  const range = localStorage.getItem('popupRankingRange') || 'day';
  const label = getRankingRangeLabel(popupRecommendLang, range);
  if (hint) hint.textContent = `${label} >`;

  const { startTime, endTime } = getRankingRangeConfig(range);
  const maxResults = range === 'all' ? 500 : 200;

  const loadingTimer = schedulePopupListLoading(list, getPopupText('widgetLoading', popupRecommendLang));
  const bookmarkMap = await loadBookmarkUrlMap();
  if (!bookmarkMap.size) {
    if (loadingTimer) clearTimeout(loadingTimer);
    setPopupListEmpty(list, getPopupText('rankingEmpty', popupRecommendLang));
    return;
  }

  const historyItems = await new Promise((resolve) => {
    browserAPI.history.search({ text: '', startTime, endTime, maxResults }, resolve);
  });

  const candidates = (historyItems || [])
    .filter(item => item.url && bookmarkMap.has(item.url))
    .slice(0, 60);

  let ranked = [];
  if (range === 'all') {
    ranked = candidates.map(item => ({
      url: item.url,
      title: bookmarkMap.get(item.url) || item.title || item.url,
      count: item.visitCount || 0
    }));
  } else {
    const limited = candidates.slice(0, 30);
    const counts = await Promise.all(limited.map(item => new Promise((resolve) => {
      browserAPI.history.getVisits({ url: item.url }, (visits) => {
        const count = (visits || []).filter(v => v.visitTime >= startTime && v.visitTime <= endTime).length;
        resolve({ url: item.url, title: bookmarkMap.get(item.url) || item.title || item.url, count });
      });
    })));
    ranked = counts;
  }

  ranked = ranked.filter(item => item.count > 0).sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, 5);

  if (!top.length) {
    if (loadingTimer) clearTimeout(loadingTimer);
    setPopupListEmpty(list, getPopupText('rankingEmpty', popupRecommendLang));
    return;
  }
  if (loadingTimer) clearTimeout(loadingTimer);

  const renderKey = JSON.stringify(top.map(item => ({
    url: item.url || '',
    title: item.title || '',
    count: item.count || 0
  })));

  setPopupListData(list, renderKey, () => {
    top.forEach((item, index) => {
      const el = document.createElement('div');
      el.className = 'time-tracking-widget-item ranking-item';

      const rankNum = document.createElement('span');
      rankNum.className = 'item-rank';
      rankNum.textContent = `${index + 1}`;

      const title = document.createElement('span');
      title.className = 'item-title';
      title.textContent = item.title || item.url;
      title.title = item.title || item.url;

      const count = document.createElement('span');
      count.className = 'item-time';
      count.textContent = popupRecommendLang === 'en' ? `${item.count}x` : `${item.count}次`;

      el.appendChild(rankNum);
      el.appendChild(title);
      el.appendChild(count);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.url) safeCreateTab({ url: item.url });
      });

      list.appendChild(el);
    });
  });
}

function loadPopupShortcuts() {
  const fallback = { records: 'Alt+4', recommend: 'Alt+5' };
  if (!browserAPI?.commands?.getAll) {
    popupShortcuts = fallback;
    return Promise.resolve(popupShortcuts);
  }
  return new Promise((resolve) => {
    try {
      browserAPI.commands.getAll((commands) => {
        const nextShortcuts = { ...fallback };
        if (Array.isArray(commands)) {
          const recordsCmd = commands.find(c => c.name === 'open_additions_view');
          const recommendCmd = commands.find(c => c.name === 'open_recommend_view');
          if (recordsCmd?.shortcut) nextShortcuts.records = recordsCmd.shortcut;
          if (recommendCmd?.shortcut) nextShortcuts.recommend = recommendCmd.shortcut;
        }
        popupShortcuts = nextShortcuts;
        resolve(nextShortcuts);
      });
    } catch (_) {
      popupShortcuts = fallback;
      resolve(fallback);
    }
  });
}

function setupOpenSourceDialog() {
  const openSourceInfoBtn = document.getElementById('openSourceInfoBtn');
  const openSourceInfoDialog = document.getElementById('openSourceInfoDialog');
  const closeOpenSourceDialog = document.getElementById('closeOpenSourceDialog');
  const openSourceTooltip = document.getElementById('openSourceTooltip');
  if (!openSourceInfoBtn || !openSourceInfoDialog || !closeOpenSourceDialog) return;

  openSourceInfoBtn.addEventListener('click', () => {
    openSourceInfoDialog.style.display = 'block';
    openSourceInfoDialog.setAttribute('aria-hidden', 'false');
  });

  closeOpenSourceDialog.addEventListener('click', () => {
    openSourceInfoDialog.style.display = 'none';
    openSourceInfoDialog.setAttribute('aria-hidden', 'true');
  });

  openSourceInfoDialog.addEventListener('click', (e) => {
    if (e.target === openSourceInfoDialog) {
      openSourceInfoDialog.style.display = 'none';
      openSourceInfoDialog.setAttribute('aria-hidden', 'true');
    }
  });

  if (openSourceTooltip) {
    openSourceInfoBtn.addEventListener('mouseenter', () => {
      openSourceTooltip.style.visibility = 'visible';
      openSourceTooltip.style.opacity = '1';
    });
    openSourceInfoBtn.addEventListener('mouseleave', () => {
      openSourceTooltip.style.visibility = 'hidden';
      openSourceTooltip.style.opacity = '0';
    });
  }
}

function setupShortcutsSettingsButton() {
  const btn = document.getElementById('openShortcutsSettingsBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    try {
      const ua = navigator.userAgent || '';
      const url = ua.includes('Edg/') ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
      safeCreateTab({ url });
    } catch (_) {}
  });
}

function setupLanguageToggle() {
  const langToggleButton = document.getElementById('lang-toggle-btn');
  if (!langToggleButton) return;
  langToggleButton.addEventListener('click', () => {
    const nextLang = popupRecommendLang === 'zh_CN' ? 'en' : 'zh_CN';
    setPreferredLang(nextLang);
    updatePopupLanguage(nextLang);
  });
}

function getRecentFaviconFallback() {
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Cpath fill=%22%23999%22 d=%22M8 0l2.8 5.5 6.2 0.5-4.5 4 1.5 6-5.5-3.5-5.5 3.5 1.5-6-4.5-4 6.2-0.5z%22/%3E%3C/svg%3E';
}

function loadFaviconForRecent(imgElement, url) {
  try {
    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
      imgElement.src = getRecentFaviconFallback();
      return;
    }

    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const faviconSources = [
      // 避免直接请求 `${origin}/favicon.ico`：部分站点会返回 HTML（含 preload），导致控制台 warning 刷屏。
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    ];

    let index = 0;
    const tryNext = () => {
      if (index >= faviconSources.length) {
        imgElement.src = getRecentFaviconFallback();
        return;
      }
      const testImg = new Image();
      const src = faviconSources[index];
      index += 1;

      let timeoutId = setTimeout(() => {
        testImg.onload = null;
        testImg.onerror = null;
        tryNext();
      }, 3000);

      testImg.onload = () => {
        clearTimeout(timeoutId);
        imgElement.src = src;
      };

      testImg.onerror = () => {
        clearTimeout(timeoutId);
        tryNext();
      };

      testImg.src = src;
    };

    imgElement.src = getRecentFaviconFallback();
    tryNext();
  } catch (_) {
    imgElement.src = getRecentFaviconFallback();
  }
}

function getInternalFaviconUrl(url) {
  return null;
}

function getPopupFaviconFromBackground(url) {
  return new Promise((resolve) => {
    if (!browserAPI?.runtime?.sendMessage || !url) {
      resolve(null);
      return;
    }
    browserAPI.runtime.sendMessage({ action: 'getPopupFavicon', url }, (response) => {
      if (browserAPI.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response?.dataUrl || null);
      }
    });
  });
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, timeoutMs);
    promise.then((value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function getCachedPopupScoreDebug(bookmarkId) {
  const entry = popupScoreDebugCache.get(bookmarkId);
  if (!entry) return null;
  if ((Date.now() - entry.time) > POPUP_SCORE_DEBUG_CACHE_TTL_MS) {
    popupScoreDebugCache.delete(bookmarkId);
    return null;
  }
  return entry.debug || null;
}

function setCachedPopupScoreDebug(bookmarkId, debug) {
  if (!bookmarkId || !debug) return;
  popupScoreDebugCache.set(bookmarkId, { time: Date.now(), debug });
}

function getFreshPopupScoreDebug(bookmarkId) {
  if (!bookmarkId) return Promise.resolve(null);
  const key = String(bookmarkId);
  if (popupScoreDebugInFlight.has(key)) {
    return popupScoreDebugInFlight.get(key);
  }
  const promise = withTimeout(requestPopupScoreDebug(key), 3500)
    .catch(() => null)
    .finally(() => {
      popupScoreDebugInFlight.delete(key);
    });
  popupScoreDebugInFlight.set(key, promise);
  return promise;
}

function requestPopupScoreDebug(bookmarkId) {
  return new Promise((resolve) => {
    if (!browserAPI?.runtime?.sendMessage || !bookmarkId) {
      resolve(null);
      return;
    }
    browserAPI.runtime.sendMessage({ action: 'getBookmarkScoreDebug', bookmarkId }, (response) => {
      if (browserAPI.runtime.lastError) {
        resolve(null);
      } else if (response?.success && response?.debug) {
        resolve(response.debug);
      } else {
        resolve(null);
      }
    });
  });
}

function formatPopupDebugTime(ts) {
  const t = Number(ts || 0);
  if (!t) return '--';
  try {
    return new Date(t).toLocaleString();
  } catch (_) {
    return String(t);
  }
}

function formatPopupScoreDebugText(debug) {
  const isEn = popupRecommendLang === 'en';
  const lines = [];
  if (!debug) {
    return isEn ? 'No debug data.' : '没有诊断数据。';
  }

  const f = debug.factors || {};
  const h = debug.matches?.history || {};
  const t = debug.matches?.tracking || {};
  const raw = debug.raw || {};
  const w = debug.weightsUsed || {};
  const th = debug.config?.thresholds || {};
  const storage = debug.storage || {};
  const cachedS = typeof storage.cachedEntry?.S === 'number' ? storage.cachedEntry.S : null;

  const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : '--');
  const fmtDays = (v) => (typeof v === 'number' ? v.toFixed(2) : '--');

  if (cachedS != null && typeof f.S === 'number') {
    if (isEn) {
      lines.push(`S=${cachedS.toFixed(3)} (old)  S=${f.S.toFixed(3)} (new)`);
    } else {
      lines.push(`S=${cachedS.toFixed(3)}（旧）  S=${f.S.toFixed(3)}（新）`);
    }
  } else {
    lines.push(`S=${fmt(f.S)}`);
  }
  lines.push(`F=${fmt(f.F)} C=${fmt(f.C)} T=${fmt(f.T)} D=${fmt(f.D)} L=${fmt(f.L)} R=${fmt(f.R)}`);
  lines.push(`AddedΔ=${fmtDays(raw.daysSinceAdded)}d  LastVisitΔ=${fmtDays(raw.daysSinceLastVisit)}d  T(min)=${fmtDays(raw.compositeMinutes)}`);
  lines.push('');

  lines.push(`History: ${h.type || 'none'}  visits=${h.visitCount ?? 0}  last=${formatPopupDebugTime(h.lastVisitTime)}`);
  lines.push(`Tracking: ${t.type || 'none'}  ms=${t.compositeMs ?? 0}${t.ignoredTitleHit ? '  (ignored title hit)' : ''}`);
  lines.push('');

  lines.push(`WeightsUsed: w1=${fmt(w.w1)} w2=${fmt(w.w2)} w3=${fmt(w.w3)} w4=${fmt(w.w4)} w5=${fmt(w.w5)}`);
  lines.push(`Thresholds: freshness=${th.freshness ?? '--'} coldness=${th.coldness ?? '--'} shallowRead=${th.shallowRead ?? '--'} forgetting=${th.forgetting ?? '--'}`);
  lines.push('');

  lines.push(`Cache: mode=${storage.cacheMode || '--'} algo=v${storage.algoVersion || '--'} cachedS=${cachedS == null ? '--' : cachedS.toFixed(3)} time=${storage.recommendScoresTime || 0}`);
  if (storage.staleMeta?.staleAt) {
    lines.push(`StaleMeta: at=${formatPopupDebugTime(storage.staleMeta.staleAt)} reason=${storage.staleMeta.reason || ''}`);
  }

  if (Array.isArray(debug.notes) && debug.notes.length) {
    lines.push('');
    lines.push(isEn ? 'Notes:' : '备注:');
    debug.notes.forEach((note) => lines.push(`- ${note}`));
  }

  return lines.join('\n');
}

function requestPopupFavicon(imgElement, url) {
  if (!imgElement) return;
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
    imgElement.src = getRecentFaviconFallback();
    return;
  }

  if (popupFaviconRequestCache.has(url)) {
    popupFaviconRequestCache.get(url).then((dataUrl) => {
      if (dataUrl && imgElement.isConnected) imgElement.src = dataUrl;
    });
    return;
  }

  const task = getPopupFaviconFromBackground(url).then((dataUrl) => {
    if (dataUrl) {
      if (imgElement.isConnected) imgElement.src = dataUrl;
      return dataUrl;
    }
    loadFaviconForRecent(imgElement, url);
    return null;
  }).catch(() => {
    loadFaviconForRecent(imgElement, url);
    return null;
  });

  popupFaviconRequestCache.set(url, task);
}

function prefetchPopupFavicons(urls) {
  if (!browserAPI?.runtime?.sendMessage || !Array.isArray(urls) || urls.length === 0) return;
  browserAPI.runtime.sendMessage({ action: 'prefetchPopupFavicons', urls }, () => {});
}

function comparePopupRecommendPriority(a, b) {
  const diff = (b?.priority ?? 0) - (a?.priority ?? 0);
  if (Math.abs(diff) >= 0.01) return diff;
  const bAdded = Number(b?.dateAdded || 0);
  const aAdded = Number(a?.dateAdded || 0);
  if (bAdded !== aAdded) return bAdded - aAdded;
  const aTitle = String(a?.title || a?.name || '').toLowerCase();
  const bTitle = String(b?.title || b?.name || '').toLowerCase();
  if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

async function prefetchNextPopupBatch(bookmarks, scoresCache, reviewData, postponedList, currentCardIds) {
  try {
    if (!bookmarks || bookmarks.length === 0) return;
    const [flippedList, blockedData] = await Promise.all([
      getPopupFlippedBookmarks(),
      getPopupBlockedBookmarks()
    ]);

    const now = Date.now();
    const flippedSet = new Set(flippedList || []);
    const blockedBookmarks = new Set(blockedData.bookmarks || []);
    const blockedFolders = new Set(blockedData.folders || []);
    const blockedDomains = new Set((blockedData.domains || []).map(normalizeDomain));
    const postponedSet = new Set(
      (postponedList || []).filter(item => item.postponeUntil > now).map(item => item.bookmarkId)
    );
    const currentSet = new Set(currentCardIds || []);

    const baseFilter = (bookmark) => {
      if (!bookmark.url) return false;
      if (flippedSet.has(bookmark.id)) return false;
      if (popupSkippedBookmarks.has(bookmark.id)) return false;
      if (blockedBookmarks.has(bookmark.id)) return false;
      if (postponedSet.has(bookmark.id)) return false;

      if (blockedFolders.size && bookmark.ancestorFolderIds) {
        for (const folderId of bookmark.ancestorFolderIds) {
          if (blockedFolders.has(folderId)) return false;
        }
      }

      if (blockedDomains.size && bookmark.domain) {
        const normalized = normalizeDomain(bookmark.domain);
        if (blockedDomains.has(normalized)) return false;
      }

      return true;
    };

    const available = bookmarks.filter(b => baseFilter(b) && !currentSet.has(b.id));
    if (!available.length) return;

    const candidates = available.map(b => {
      const cached = scoresCache?.[b.id];
      const basePriority = cached ? cached.S : 0.5;
      const priority = basePriority;
      return { ...b, priority };
    });

    candidates.sort(comparePopupRecommendPriority);

    const prefetchList = candidates
      .slice(0, POPUP_RECOMMEND_CARD_COUNT + 6)
      .map(item => item.url)
      .filter(Boolean);

    prefetchPopupFavicons(prefetchList);
  } catch (_) {}
}

async function updatePopupCardDataFavicons(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) return;

  try {
    const currentCards = await getPopupCurrentCards();
    if (!currentCards || !currentCards.cardIds || currentCards.cardIds.length === 0) return;

    const existingMap = new Map();
    if (Array.isArray(currentCards.cardData)) {
      currentCards.cardData.forEach((data) => {
        if (data && data.id) existingMap.set(data.id, data);
      });
    }

    let changed = false;
    const cardData = await Promise.all(bookmarks.map(async (bookmark) => {
      if (!bookmark) return { id: null, title: '', url: '', favicon: null, priority: 0 };
      const existing = existingMap.get(bookmark.id) || {};
      const title = bookmark.title || existing.title || '';
      const url = bookmark.url || existing.url || '';
      let favicon = existing.favicon || existing.faviconUrl || null;

      if (!favicon && url) {
        favicon = await getPopupFaviconFromBackground(url);
      }

      const priority = typeof existing.priority === 'number'
        ? existing.priority
        : (typeof bookmark.priority === 'number' ? bookmark.priority : 0);

      if (title !== (existing.title || '')) changed = true;
      if (favicon && favicon !== (existing.favicon || existing.faviconUrl || null)) changed = true;

      return {
        id: bookmark.id,
        title,
        url,
        favicon,
        priority
      };
    }));

    if (!changed) return;

    await savePopupCurrentCards(currentCards.cardIds, currentCards.flippedIds || [], cardData);
  } catch (_) {}
}

function normalizeDomain(domain) {
  if (!domain) return '';
  return domain.toLowerCase().replace(/^www\./, '');
}

async function getPopupCurrentCards() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['popupCurrentCards'], (result) => {
      resolve(result.popupCurrentCards || null);
    });
  });
}

async function savePopupCurrentCards(cardIds, flippedIds, cardData = null) {
  popupLastSaveTime = Date.now();
  const data = {
    cardIds,
    flippedIds,
    timestamp: Date.now()
  };
  if (cardData) data.cardData = cardData;
  await browserAPI.storage.local.set({ popupCurrentCards: data });
}

async function renderPopupRecommendCardsFromStorage() {
  try {
    const cardsRoot = document.getElementById('bookmarkRecommendCards');
    if (!cardsRoot) return false;
    const cards = cardsRoot.querySelectorAll('.popup-recommend-card');
    if (!cards.length) return false;

    const currentCards = await getPopupCurrentCards();
    if (!currentCards?.cardIds?.length) return false;

    const flippedIds = Array.isArray(currentCards.flippedIds) ? currentCards.flippedIds : [];
    const flippedSet = new Set(flippedIds);

    const cardDataMap = new Map();
    if (Array.isArray(currentCards.cardData)) {
      currentCards.cardData.forEach((item) => {
        if (item?.id) cardDataMap.set(item.id, item);
      });
    }

    popupRecommendCards = currentCards.cardIds.slice(0, POPUP_RECOMMEND_CARD_COUNT).map((id) => {
      const meta = cardDataMap.get(id) || {};
      return {
        id,
        title: meta.title || '',
        url: meta.url || '',
        priority: typeof meta.priority === 'number' ? meta.priority : 0.5,
        factors: {}
      };
    }).filter((b) => b && b.id);

    cards.forEach((card, index) => {
      const bookmark = popupRecommendCards[index];
      if (!bookmark) {
        resetPopupRecommendCard(card, '--');
        return;
      }
      const meta = cardDataMap.get(bookmark.id) || {};
      const favicon = meta.favicon || meta.faviconUrl || getRecentFaviconFallback();
      populatePopupRecommendCard(card, bookmark, favicon);
      if (flippedSet.has(bookmark.id)) {
        card.classList.add('flipped');
      }
    });

    // 后台预取缺失的 favicon 并写回 storage（不更新本次 DOM，避免“打开即闪”）
    try {
      const need = popupRecommendCards.filter((b) => {
        const meta = cardDataMap.get(b.id) || {};
        return b.url && !(meta.favicon || meta.faviconUrl);
      });
      if (need.length) {
        Promise.all(need.map(async (b) => {
          const dataUrl = await withTimeout(getPopupFaviconFromBackground(b.url), 1500);
          if (!dataUrl) return null;
          return { id: b.id, dataUrl };
        })).then(async (results) => {
          const updates = (results || []).filter(Boolean);
          if (!updates.length) return;

          const nextCardData = Array.isArray(currentCards.cardData) ? currentCards.cardData.map((item) => ({ ...item })) : [];
          updates.forEach(({ id, dataUrl }) => {
            const idx = nextCardData.findIndex((item) => item?.id === id);
            if (idx >= 0) {
              nextCardData[idx].favicon = dataUrl;
            }
          });
          await savePopupCurrentCards(currentCards.cardIds, flippedIds, nextCardData);
        }).catch(() => { });
      }
    } catch (_) { }

    return true;
  } catch (_) {
    return false;
  }
}

async function markPopupCardFlipped(bookmarkId) {
  const currentCards = await getPopupCurrentCards();
  if (!currentCards) return false;
  if (!currentCards.flippedIds.includes(bookmarkId)) {
    currentCards.flippedIds.push(bookmarkId);
    await savePopupCurrentCards(currentCards.cardIds, currentCards.flippedIds);
  }
  return currentCards.cardIds.every(id => currentCards.flippedIds.includes(id));
}

async function getPopupScoresCache() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_scores_cache'], (result) => {
      resolve(result.recommend_scores_cache || {});
    });
  });
}

async function requestComputeScores() {
  return new Promise((resolve) => {
    browserAPI.runtime.sendMessage({ action: 'computeBookmarkScores' }, (response) => {
      if (browserAPI.runtime.lastError) {
        resolve(false);
      } else {
        resolve(!!(response?.computed || response?.success));
      }
    });
  });
}

async function getPopupFlippedBookmarks() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['flippedBookmarks'], (result) => {
      resolve(result.flippedBookmarks || []);
    });
  });
}

async function markPopupBookmarkFlipped(bookmarkId) {
  const flipped = await getPopupFlippedBookmarks();
  if (!flipped.includes(bookmarkId)) {
    flipped.push(bookmarkId);
    await browserAPI.storage.local.set({ flippedBookmarks: flipped });
  }

  const result = await new Promise((resolve) => {
    browserAPI.storage.local.get(['flipHistory'], resolve);
  });
  const flipHistory = result.flipHistory || [];
  flipHistory.push({ bookmarkId, timestamp: Date.now() });
  await browserAPI.storage.local.set({ flipHistory });
}

async function fetchAllBookmarksFlat() {
  const tree = await new Promise((resolve) => {
    browserAPI.bookmarks.getTree(resolve);
  });

  if (!tree || !tree.length) return [];

  const results = [];
  function traverse(nodes, ancestorFolderIds = []) {
    nodes.forEach(node => {
      if (node.url) {
        results.push({
          id: node.id,
          title: node.title || node.name || '',
          url: node.url,
          dateAdded: node.dateAdded,
          domain: normalizeDomain((() => {
            try { return new URL(node.url).hostname; } catch (_) { return ''; }
          })()),
          ancestorFolderIds
        });
      }
      if (node.children && node.children.length) {
        const nextAncestors = node.url ? ancestorFolderIds : [...ancestorFolderIds, node.id];
        traverse(node.children, nextAncestors);
      }
    });
  }
  traverse(tree, []);
  return results;
}

async function getPopupBlockedBookmarks() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_blocked'], (result) => {
      resolve(result.recommend_blocked || { bookmarks: [], folders: [], domains: [] });
    });
  });
}

async function blockPopupBookmark(bookmarkId) {
  try {
    const targetList = await new Promise((resolve) => {
    browserAPI.bookmarks.get(bookmarkId, resolve);
  });
  if (!targetList || !targetList.length) return false;

  const targetTitle = targetList[0].title || targetList[0].name || '';
    const allBookmarks = await fetchAllBookmarksFlat();
    const sameTitleBookmarks = allBookmarks.filter(b => b.title === targetTitle);

    const blocked = await getPopupBlockedBookmarks();
    let updated = false;
    sameTitleBookmarks.forEach(bookmark => {
      if (!blocked.bookmarks.includes(bookmark.id)) {
        blocked.bookmarks.push(bookmark.id);
        updated = true;
      }
    });

    if (updated) {
      await browserAPI.storage.local.set({ recommend_blocked: blocked });
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function getPopupPostponedBookmarks() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_postponed'], (result) => {
      resolve(result.recommend_postponed || []);
    });
  });
}

async function postponeRecommendBookmark(bookmarkId, delayMs) {
  const postponed = await getPopupPostponedBookmarks();
  const now = Date.now();
  const existing = postponed.find(item => item.bookmarkId === bookmarkId);

  if (existing) {
    existing.postponeUntil = now + delayMs;
    existing.postponeCount = (existing.postponeCount || 0) + 1;
    existing.updatedAt = now;
  } else {
    postponed.push({
      bookmarkId,
      postponeUntil: now + delayMs,
      postponeCount: 1,
      createdAt: now,
      updatedAt: now
    });
  }

  await browserAPI.storage.local.set({ recommend_postponed: postponed });
}

async function getPopupReviewData() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_reviews'], (result) => {
      resolve(result.recommend_reviews || {});
    });
  });
}

async function recordPopupReview(bookmarkId) {
  const reviews = await getPopupReviewData();
  const now = Date.now();
  const existing = reviews[bookmarkId];

  if (existing) {
    const newInterval = Math.min(existing.interval * 2, 30);
    reviews[bookmarkId] = {
      lastReview: now,
      interval: newInterval,
      reviewCount: existing.reviewCount + 1,
      nextReview: now + newInterval * 24 * 60 * 60 * 1000
    };
  } else {
    reviews[bookmarkId] = {
      lastReview: now,
      interval: 1,
      reviewCount: 1,
      nextReview: now + 24 * 60 * 60 * 1000
    };
  }

  await browserAPI.storage.local.set({ recommend_reviews: reviews });
  try {
    browserAPI.runtime.sendMessage({ action: 'updateBookmarkScore', bookmarkId }, () => {});
  } catch (_) {}
}

function getPopupReviewStatus(bookmarkId, reviewData) {
  const review = reviewData[bookmarkId];
  if (!review) return { priority: 1 };

  const now = Date.now();
  if (now >= review.nextReview) return { priority: 1.2 };

  const daysSinceReview = (now - review.lastReview) / (1000 * 60 * 60 * 24);
  if (daysSinceReview >= review.interval * 0.7) return { priority: 1.1 };

  return { priority: 0.9 };
}

function calculatePopupPriorityWithReview(basePriority, bookmarkId, reviewData, postponedData) {
  let priority = basePriority;
  const reviewStatus = getPopupReviewStatus(bookmarkId, reviewData);
  priority *= reviewStatus.priority || 1;

  const postponeInfo = postponedData.find(item => item.bookmarkId === bookmarkId);
  if (postponeInfo && postponeInfo.postponeCount > 0) {
    priority *= Math.pow(0.9, postponeInfo.postponeCount);
  }

  return Math.min(priority, 1.5);
}

function resetPopupRecommendCard(card, message) {
  card.classList.add('empty');
  card.classList.remove('flipped');
  card.classList.remove('debug-open');
  card.dataset.bookmarkId = '';

  const titleEl = card.querySelector('.popup-recommend-title');
  if (titleEl) titleEl.textContent = message;
  const priorityEl = card.querySelector('.popup-recommend-priority');
  if (priorityEl) priorityEl.textContent = 'S = --';
  const favicon = card.querySelector('.popup-recommend-favicon');
  if (favicon) favicon.src = getRecentFaviconFallback();

  const debugOverlay = card.querySelector('.popup-recommend-debug');
  if (debugOverlay) debugOverlay.setAttribute('aria-hidden', 'true');
  const debugPre = card.querySelector('.popup-recommend-debug-pre');
  if (debugPre) debugPre.textContent = '--';

  card.onclick = null;
  card.querySelectorAll('.popup-card-btn').forEach(btn => { btn.onclick = null; });
  const debugBtn = card.querySelector('.popup-card-debug-btn');
  if (debugBtn) debugBtn.onclick = null;
  const closeBtn = card.querySelector('.popup-card-debug-close-btn');
  if (closeBtn) closeBtn.onclick = null;
}

async function openPopupRecommendTarget(url) {
  if (!url) return;
  await safeCreateTab({ url });
}

function populatePopupRecommendCard(card, bookmark, cachedFaviconUrl = null) {
  card.classList.remove('empty');
  card.classList.remove('flipped');
  card.classList.remove('debug-open');
  card.dataset.bookmarkId = bookmark.id;

  const titleEl = card.querySelector('.popup-recommend-title');
  if (titleEl) {
    titleEl.textContent = bookmark.title || bookmark.url || (popupRecommendLang === 'en' ? '(No title)' : '（无标题）');
  }

  const favicon = card.querySelector('.popup-recommend-favicon');
  if (favicon) {
    if (cachedFaviconUrl) {
      favicon.src = cachedFaviconUrl;
    } else {
      favicon.src = getRecentFaviconFallback();
      requestPopupFavicon(favicon, bookmark.url);
    }
  }

  const priorityEl = card.querySelector('.popup-recommend-priority');
  if (priorityEl) {
    priorityEl.textContent = `S = ${bookmark.priority.toFixed(3)}`;
  }

  const debugOverlay = card.querySelector('.popup-recommend-debug');
  if (debugOverlay) debugOverlay.setAttribute('aria-hidden', 'true');
  const debugPre = card.querySelector('.popup-recommend-debug-pre');
  if (debugPre) debugPre.textContent = '--';

  const closeDebug = () => {
    card.classList.remove('debug-open');
    if (debugOverlay) debugOverlay.setAttribute('aria-hidden', 'true');
  };

  const openDebug = async () => {
    if (!debugOverlay || !debugPre) return;
    card.classList.add('debug-open');
    debugOverlay.setAttribute('aria-hidden', 'false');
    const cached = getCachedPopupScoreDebug(bookmark.id);
    if (cached) {
      debugPre.textContent = formatPopupScoreDebugText(cached);
    } else {
      debugPre.textContent = popupRecommendLang === 'en' ? 'Loading...' : '加载中...';
    }

    const debug = await getFreshPopupScoreDebug(bookmark.id);
    if (!debug) {
      if (!cached) {
        debugPre.textContent = popupRecommendLang === 'en' ? 'Load failed.' : '加载失败。';
      }
      return;
    }
    setCachedPopupScoreDebug(bookmark.id, debug);
    debugPre.textContent = formatPopupScoreDebugText(debug);
  };

  const debugBtn = card.querySelector('.popup-card-debug-btn');
  if (debugBtn) {
    debugBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (card.classList.contains('debug-open')) {
        closeDebug();
      } else {
        openDebug();
      }
    };
  }

  const debugCloseBtn = card.querySelector('.popup-card-debug-close-btn');
  if (debugCloseBtn) {
    debugCloseBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeDebug();
    };
  }

  if (debugOverlay) {
    debugOverlay.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
  }

  card.onclick = async (event) => {
    if (event.target.closest('.popup-recommend-actions')) return;
    if (event.target.closest('.popup-card-debug-btn')) return;
    if (event.target.closest('.popup-recommend-debug')) return;
    try {
      await markPopupBookmarkFlipped(bookmark.id);
      await recordPopupReview(bookmark.id);
      await openPopupRecommendTarget(bookmark.url);
      card.classList.add('flipped');
      const allFlipped = await markPopupCardFlipped(bookmark.id);
      if (allFlipped) {
        await refreshPopupRecommendCards(true);
      }
    } catch (_) {
      showStatus(popupRecommendLang === 'en' ? 'Open failed' : '打开失败', 'error');
    }
  };

  const blockBtn = card.querySelector('.popup-card-btn-block');
  if (blockBtn) {
    blockBtn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const success = await blockPopupBookmark(bookmark.id);
      showStatus(success ? (popupRecommendLang === 'en' ? 'Blocked' : '已屏蔽') : (popupRecommendLang === 'en' ? 'Block failed' : '屏蔽失败'), success ? 'success' : 'error');
      await refreshPopupRecommendCards(true);
    };
  }

  const laterBtn = card.querySelector('.popup-card-btn-later');
  if (laterBtn) {
    laterBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      popupCurrentLaterBookmark = bookmark;
      showPopupRecommendLaterOverlay();
    };
  }

  const skipBtn = card.querySelector('.popup-card-btn-skip');
  if (skipBtn) {
    skipBtn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      popupSkippedBookmarks.add(bookmark.id);
      await refreshPopupRecommendCards(true);
    };
  }
}

function showPopupRecommendLaterOverlay() {
  const overlay = document.getElementById('popupRecommendLaterOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
}

function hidePopupRecommendLaterOverlay() {
  const overlay = document.getElementById('popupRecommendLaterOverlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}

async function refreshPopupRecommendCards(force = false) {
  if (popupRecommendLoading && !force) return;
  const cardsRoot = document.getElementById('bookmarkRecommendCards');
  if (!cardsRoot) return;
  const cards = cardsRoot.querySelectorAll('.popup-recommend-card');
  if (!cards.length) return;

  let didRefreshCards = false;
  const shouldAutoRefresh = await incrementPopupOpenCount();
  if (shouldAutoRefresh && !force) {
    force = true;
  }

  popupRecommendLoading = true;

  try {
    const currentCards = await getPopupCurrentCards();
    const bookmarks = await fetchAllBookmarksFlat();
    const bookmarkMap = new Map(bookmarks.map(b => [b.id, b]));

    if (currentCards && currentCards.cardIds && currentCards.cardIds.length > 0 && !force) {
      const allFlipped = currentCards.cardIds.every(id => currentCards.flippedIds.includes(id));
      if (!allFlipped) {
        const reviewData = await getPopupReviewData();
        const postponedList = await getPopupPostponedBookmarks();

        const cachedCardDataMap = new Map();
        if (currentCards.cardData && Array.isArray(currentCards.cardData)) {
          currentCards.cardData.forEach(data => {
            if (data && data.id) {
              cachedCardDataMap.set(data.id, {
                favicon: data.favicon || data.faviconUrl || null,
                priority: data.priority || 0,
                title: data.title || ''
              });
            }
          });
        }

        let scoresCache = await getPopupScoresCache();
        if (Object.keys(scoresCache).length === 0 && bookmarks.length > 0) {
          const computed = await requestComputeScores();
          if (!computed) {
            popupScoresComputeRetryCount += 1;
            if (popupScoresComputeRetryCount <= 5) {
              setTimeout(() => refreshPopupRecommendCards(true), 1500);
            }
            // 计算尚未完成：仍然渲染已保存卡片（用 cardData.priority/默认值），避免 UI 闪烁或空白。
            scoresCache = {};
          } else {
            popupScoresComputeRetryCount = 0;
            scoresCache = await getPopupScoresCache();
          }
        }

        // 尽量让“再次打开 popup 时图标直接可用”：对缺失的 favicon 做一次快速补全（优先走 background 缓存）
        const missingFaviconIds = [];
        currentCards.cardIds.forEach((id) => {
          const meta = cachedCardDataMap.get(id);
          const hasFavicon = !!(meta && (meta.favicon || meta.faviconUrl));
          if (!hasFavicon) missingFaviconIds.push(id);
        });
        if (missingFaviconIds.length) {
          await Promise.all(missingFaviconIds.slice(0, 3).map(async (id) => {
            const bookmark = bookmarkMap.get(id);
            const url = bookmark?.url;
            if (!url) return;
            const dataUrl = await withTimeout(getPopupFaviconFromBackground(url), 400);
            if (!dataUrl) return;
            const meta = cachedCardDataMap.get(id) || {};
            cachedCardDataMap.set(id, { ...meta, favicon: dataUrl });
          }));

          try {
            // 仅当有变化时写回 storage，保证下次打开“秒出图标”
            if (Array.isArray(currentCards.cardData)) {
              const nextCardData = currentCards.cardData.map((item) => {
                if (!item?.id) return item;
                const meta = cachedCardDataMap.get(item.id);
                if (!meta?.favicon) return item;
                if (item.favicon === meta.favicon || item.faviconUrl === meta.favicon) return item;
                return { ...item, favicon: meta.favicon };
              });
              await savePopupCurrentCards(currentCards.cardIds, currentCards.flippedIds || [], nextCardData);
            }
          } catch (_) { }
        }

        popupRecommendCards = currentCards.cardIds.map(id => {
          const bookmark = bookmarkMap.get(id);
          if (bookmark) {
            const cached = scoresCache[id];
            const cachedData = cachedCardDataMap.get(id);
            const safeTitle = bookmark.title || bookmark.name || cachedData?.title || '';
            const safeUrl = bookmark.url || cachedData?.url || '';
            const basePriority = cached ? cached.S : (cachedData?.priority || 0.5);
            const priority = basePriority;
            return { ...bookmark, title: safeTitle, url: safeUrl, priority, factors: cached || {} };
          }
          return null;
        }).filter(Boolean);

        prefetchPopupFavicons(popupRecommendCards.map(card => card.url).filter(Boolean));
        setTimeout(() => {
          prefetchNextPopupBatch(bookmarks, scoresCache, reviewData, postponedList, currentCards.cardIds);
        }, 0);
        updatePopupCardDataFavicons(popupRecommendCards);

        cards.forEach((card, index) => {
          const bookmark = popupRecommendCards[index];
          if (bookmark) {
            const cachedData = cachedCardDataMap.get(bookmark.id);
            populatePopupRecommendCard(card, bookmark, cachedData?.favicon || cachedData?.faviconUrl || null);
            if (currentCards.flippedIds.includes(bookmark.id)) {
              card.classList.add('flipped');
            }
          } else {
            resetPopupRecommendCard(card, '--');
          }
        });

        popupRecommendLoading = false;
        return;
      }
    }

    const [flippedList, blockedData, postponedList] = await Promise.all([
      getPopupFlippedBookmarks(),
      getPopupBlockedBookmarks(),
      getPopupPostponedBookmarks()
    ]);

    const now = Date.now();
    const flippedSet = new Set(flippedList || []);
    const blockedBookmarks = new Set(blockedData.bookmarks || []);
    const blockedFolders = new Set(blockedData.folders || []);
    const blockedDomains = new Set((blockedData.domains || []).map(normalizeDomain));
    const postponedSet = new Set(
      postponedList.filter(item => item.postponeUntil > now).map(item => item.bookmarkId)
    );

    const baseFilter = (bookmark) => {
      if (!bookmark.url) return false;
      if (flippedSet.has(bookmark.id)) return false;
      if (popupSkippedBookmarks.has(bookmark.id)) return false;
      if (blockedBookmarks.has(bookmark.id)) return false;
      if (postponedSet.has(bookmark.id)) return false;

      if (blockedFolders.size && bookmark.ancestorFolderIds) {
        for (const folderId of bookmark.ancestorFolderIds) {
          if (blockedFolders.has(folderId)) return false;
        }
      }

      if (blockedDomains.size && bookmark.domain) {
        const normalized = normalizeDomain(bookmark.domain);
        if (blockedDomains.has(normalized)) return false;
      }

      return true;
    };

    const currentCardIds = new Set(
      force && currentCards?.cardIds ? currentCards.cardIds : []
    );

    let availableBookmarks = bookmarks.filter((bookmark) =>
      baseFilter(bookmark) && !currentCardIds.has(bookmark.id)
    );

    if (availableBookmarks.length < POPUP_RECOMMEND_CARD_COUNT && currentCardIds.size > 0) {
      availableBookmarks = bookmarks.filter(baseFilter);
    }

    if (!availableBookmarks.length) {
      popupRecommendCards = [];
      await savePopupCurrentCards([], []);
      didRefreshCards = true;
      cards.forEach((card, index) => {
        const message = index === 0
          ? (popupRecommendLang === 'en' ? 'All bookmarks reviewed!' : '所有书签都已翻阅！')
          : '--';
        resetPopupRecommendCard(card, message);
      });
      popupRecommendLoading = false;
      return;
    }

    const reviewData = await getPopupReviewData();
    let scoresCache = await getPopupScoresCache();
    if (Object.keys(scoresCache).length === 0 && bookmarks.length > 0) {
      const computed = await requestComputeScores();
      if (!computed) {
        popupScoresComputeRetryCount += 1;
        if (popupScoresComputeRetryCount <= 5) {
          setTimeout(() => refreshPopupRecommendCards(true), 1500);
        }
        // 计算尚未完成：先保持“加载中”，避免随机选卡导致闪烁
        cards.forEach((card, index) => {
          const message = index === 0
            ? (popupRecommendLang === 'en' ? 'Computing...' : '计算中...')
            : '--';
          resetPopupRecommendCard(card, message);
        });
        return;
      }
      popupScoresComputeRetryCount = 0;
      scoresCache = await getPopupScoresCache();
    }

    const bookmarksWithPriority = availableBookmarks.map(b => {
      const cached = scoresCache[b.id];
      const basePriority = cached ? cached.S : 0.5;
      const priority = basePriority;
      return { ...b, priority, factors: cached || {} };
    });

    bookmarksWithPriority.sort(comparePopupRecommendPriority);

    popupRecommendCards = bookmarksWithPriority.slice(0, POPUP_RECOMMEND_CARD_COUNT);
    const prefetchList = bookmarksWithPriority
      .slice(0, POPUP_RECOMMEND_CARD_COUNT + 6)
      .map(item => item.url)
      .filter(Boolean);
    prefetchPopupFavicons(prefetchList);
    const newCardIds = popupRecommendCards.map(b => b.id);
    const faviconDataUrls = await Promise.all(popupRecommendCards.map((b) => {
      if (!b?.url) return Promise.resolve(null);
      return withTimeout(getPopupFaviconFromBackground(b.url), 400);
    }));

    const cardData = popupRecommendCards.map((b, idx) => ({
      id: b.id,
      title: b.title || '',
      url: b.url,
      favicon: faviconDataUrls[idx] || null,
      priority: b.priority
    }));
    await savePopupCurrentCards(newCardIds, [], cardData);
    didRefreshCards = true;
    updatePopupCardDataFavicons(popupRecommendCards);

    cards.forEach((card, index) => {
      const bookmark = popupRecommendCards[index];
      if (bookmark) {
        populatePopupRecommendCard(card, bookmark, faviconDataUrls[index] || null);
      } else {
        resetPopupRecommendCard(card, '--');
      }
    });
  } catch (_) {
    cards.forEach((card, index) => {
      const message = index === 0
        ? (popupRecommendLang === 'en' ? 'Load failed' : '推荐加载失败')
        : '--';
      resetPopupRecommendCard(card, message);
    });
  } finally {
    popupRecommendLoading = false;
    if (didRefreshCards) {
      await markPopupRecommendCardsRefreshed();
    }
  }
}

function updatePopupLanguage(lang) {
  popupRecommendLang = lang || detectDefaultLang();
  try {
    document.documentElement.lang = popupRecommendLang === 'zh_CN' ? 'zh' : 'en';
  } catch (_) {}
  const pageTitleElement = document.getElementById('pageTitleElement');
  if (pageTitleElement) pageTitleElement.textContent = getPopupText('pageTitle', popupRecommendLang);

  const title = document.getElementById('recommendTitle');
  if (title) title.textContent = getPopupText('recommendTitle', popupRecommendLang);

  const recordsTitle = document.getElementById('recordsTitle');
  if (recordsTitle) recordsTitle.textContent = getPopupText('recordsTitle', popupRecommendLang);

  const openRecordsBtn = document.getElementById('openRecordsBtn');
  if (openRecordsBtn) {
    openRecordsBtn.title = getPopupText('openRecordsTooltip', popupRecommendLang);
  }

  const openRecommendBtn = document.getElementById('openRecommendBtn');
  if (openRecommendBtn) {
    openRecommendBtn.title = getPopupText('openRecommendTooltip', popupRecommendLang);
  }

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.title = getPopupText('refreshTooltip', popupRecommendLang);

  const refreshSettingsBtn = document.getElementById('popupRefreshSettingsBtn');
  if (refreshSettingsBtn) refreshSettingsBtn.title = getPopupText('refreshSettingsTooltip', popupRecommendLang);

  const refreshText = document.getElementById('popupRefreshText');
  if (refreshText) refreshText.textContent = getPopupText('refreshText', popupRecommendLang);

  const laterTitle = document.getElementById('popupRecommendLaterTitle');
  if (laterTitle) laterTitle.textContent = getPopupText('laterTitle', popupRecommendLang);

  document.querySelectorAll('.popup-later-btn').forEach(btn => {
    const delay = btn.getAttribute('data-delay');
    const text = popupRecommendLaterOptionLabels[delay]?.[popupRecommendLang] || btn.textContent;
    btn.textContent = text;
  });

  updateOpenSourceText(popupRecommendLang);
  renderShortcutsList(popupRecommendLang);

  const trackingTitle = document.getElementById('popupTrackingTitle');
  if (trackingTitle) trackingTitle.textContent = getPopupText('trackingTitle', popupRecommendLang);
  const trackingEmpty = document.getElementById('popupTrackingEmptyText');
  if (trackingEmpty) trackingEmpty.textContent = getPopupText('trackingEmpty', popupRecommendLang);
  const rankingTitle = document.getElementById('popupRankingTitle');
  if (rankingTitle) rankingTitle.textContent = getPopupText('rankingTitle', popupRecommendLang);
  const rankingEmpty = document.getElementById('popupRankingEmptyText');
  if (rankingEmpty) rankingEmpty.textContent = getPopupText('rankingEmpty', popupRecommendLang);
  const rankingHint = document.getElementById('popupRankingHint');
  if (rankingHint) {
    const range = localStorage.getItem('popupRankingRange') || 'day';
    rankingHint.textContent = `${getRankingRangeLabel(popupRecommendLang, range)} >`;
  }
}

function setupPopupControls() {
  const openRecordsView = async (target = 'ranking', range = null) => {
    const view = 'additions';
    try {
      localStorage.setItem('lastActiveView', view);
      localStorage.setItem('additionsActiveTab', 'browsing');
      localStorage.setItem('browsingActiveSubTab', target === 'ranking' ? 'ranking' : 'history');
      if (target === 'ranking' && range) {
        localStorage.setItem('browsingRankingActiveRange', range);
      }
    } catch (_) {}
    try {
      await new Promise((resolve) => {
        browserAPI.storage.local.set({
          historyRequestedView: { view, time: Date.now() }
        }, resolve);
      });
    } catch (_) {}
    const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
    const url = `${baseUrl}?view=${view}`;
    await safeCreateTab({ url });
  };

  const rankingWidget = document.getElementById('popupRankingWidget');
  if (rankingWidget) {
    rankingWidget.addEventListener('click', (e) => {
      if (e.target.closest('.widget-header-action-btn') || e.target.closest('.time-tracking-widget-item')) return;
      const range = localStorage.getItem('popupRankingRange') || 'day';
      openRecordsView('ranking', range);
    });
  }

  const trackingWidget = document.getElementById('popupTrackingWidget');
  if (trackingWidget) {
    trackingWidget.addEventListener('click', (e) => {
      if (e.target.closest('.time-tracking-widget-item')) return;
      const view = 'additions';
      try {
        localStorage.setItem('lastActiveView', view);
        localStorage.setItem('additionsActiveTab', 'tracking');
      } catch (_) {}
      try {
        browserAPI.storage.local.set({ historyRequestedView: { view, time: Date.now() } }, () => {});
      } catch (_) {}
      const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
      const url = `${baseUrl}?view=${view}`;
      safeCreateTab({ url });
    });
  }

  const openRecordsBtn = document.getElementById('openRecordsBtn');
  if (openRecordsBtn) {
    openRecordsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openRecordsView('ranking');
    });
  }

  const refreshSettingsBtn = document.getElementById('popupRefreshSettingsBtn');
  if (refreshSettingsBtn) {
    refreshSettingsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        localStorage.setItem('lastActiveView', 'recommend');
      } catch (_) {}
      try {
        await new Promise((resolve) => {
          browserAPI.storage.local.set({
            historyRequestedView: { view: 'recommend', time: Date.now() },
            openRecommendRefreshSettings: true
          }, resolve);
        });
      } catch (_) {}
      const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
      const url = `${baseUrl}?view=recommend`;
      await safeCreateTab({ url });
    });
  }

  const rankingHint = document.getElementById('popupRankingHint');
  const cycleRange = () => {
    const ranges = ['day', 'week', 'month', 'year', 'all'];
    const current = localStorage.getItem('popupRankingRange') || 'day';
    let idx = ranges.indexOf(current);
    if (idx < 0) idx = 0;
    const next = ranges[(idx + 1) % ranges.length];
    localStorage.setItem('popupRankingRange', next);
    if (rankingHint) rankingHint.textContent = `${getRankingRangeLabel(popupRecommendLang, next)} >`;
    updateRankingWidget();
  };
  if (rankingHint) rankingHint.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleRange();
  });

  const openRecommendBtn = document.getElementById('openRecommendBtn');
  if (openRecommendBtn) {
    openRecommendBtn.addEventListener('click', async () => {
      const view = 'recommend';
      try {
        localStorage.setItem('lastActiveView', view);
      } catch (_) {}
      try {
        await new Promise((resolve) => {
          browserAPI.storage.local.set({
            historyRequestedView: { view, time: Date.now() }
          }, resolve);
        });
      } catch (_) {}
      const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
      const url = `${baseUrl}?view=${view}`;
      await safeCreateTab({ url });
    });
  }

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await refreshPopupRecommendCards(true);
    });
  }

  const overlay = document.getElementById('popupRecommendLaterOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hidePopupRecommendLaterOverlay();
    });
  }

  const closeBtn = document.getElementById('popupRecommendLaterClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', hidePopupRecommendLaterOverlay);
  }

  document.querySelectorAll('.popup-later-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const delayMs = Number(btn.getAttribute('data-delay') || 0);
      if (popupCurrentLaterBookmark && delayMs > 0) {
        await postponeRecommendBookmark(popupCurrentLaterBookmark.id, delayMs);
        showStatus(popupRecommendLang === 'en' ? 'Saved for later' : '已稍后提醒', 'success');
        hidePopupRecommendLaterOverlay();
        await refreshPopupRecommendCards(true);
      }
    });
  });
}

function setupStorageSync() {
  if (!browserAPI.storage || !browserAPI.storage.onChanged) return;
  browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.preferredLang) {
      const nextLang = changes.preferredLang.newValue || detectDefaultLang();
      updatePopupLanguage(nextLang);
      updateTrackingWidget();
      updateRankingWidget();
    }
    if (changes.popupCurrentCards) {
      const now = Date.now();
      if (now - popupLastSaveTime < 500) return;
      const newValue = changes.popupCurrentCards.newValue;
      if (newValue && newValue.cardIds && newValue.flippedIds) {
        const allFlipped = newValue.cardIds.every(id => newValue.flippedIds.includes(id));
        if (allFlipped && newValue.cardIds.length > 0) {
          refreshPopupRecommendCards(true);
        }
      }
    }
  });
}

function initPopup() {
  setupPopupControls();
  setupStorageSync();
  setupOpenSourceDialog();
  setupShortcutsSettingsButton();
  setupLanguageToggle();

  loadPreferredLang().then((lang) => {
    updatePopupLanguage(lang || detectDefaultLang());
    return loadPopupShortcuts();
  }).then(async () => {
    updatePopupLanguage(popupRecommendLang);
    const renderedFromStorage = await renderPopupRecommendCardsFromStorage();
    const shouldAutoRefresh = await incrementPopupOpenCount();
    if (!renderedFromStorage || shouldAutoRefresh) {
      refreshPopupRecommendCards(true);
    }
    updateTrackingWidget();
    updateRankingWidget();

    if (popupTrackingIntervalId) clearInterval(popupTrackingIntervalId);
    popupTrackingIntervalId = setInterval(updateTrackingWidget, 5000);

    if (popupRankingIntervalId) clearInterval(popupRankingIntervalId);
    popupRankingIntervalId = setInterval(updateRankingWidget, 30000);

    // Re-trigger once shortly after to avoid first-open blank state.
    setTimeout(() => {
      updateTrackingWidget();
      updateRankingWidget();
    }, 300);
  });
}

document.addEventListener('DOMContentLoaded', initPopup);
