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
  pageTitle: { zh_CN: '书签记录 & 推荐', en: 'Bookmark Records & Recommend' },
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
    zh_CN: (recordsKey, recommendKey) => `快捷键：记录 ${recordsKey} / 推荐 ${recommendKey}`,
    en: (recordsKey, recommendKey) => `Shortcuts: Records ${recordsKey} / Recommend ${recommendKey}`
  }
};

let popupRecommendLang = 'zh_CN';
let popupRecommendCards = [];
const popupSkippedBookmarks = new Set();
let popupRecommendLoading = false;
let popupOpenCountRecorded = false;
let popupLastSaveTime = 0;
let popupCurrentLaterBookmark = null;
const popupFaviconRequestCache = new Map();
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

    const DEFAULT_SETTINGS = {
      refreshEveryNOpens: 3,
      refreshAfterHours: 0,
      refreshAfterDays: 0,
      lastRefreshTime: 0,
      openCountSinceRefresh: 0
    };

    const settings = { ...DEFAULT_SETTINGS, ...(result?.recommendRefreshSettings || {}) };
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

    if (shouldRefresh) {
      settings.openCountSinceRefresh = 0;
      settings.lastRefreshTime = now;
    }

    await new Promise((resolve) => {
      browserAPI.storage.local.set({ recommendRefreshSettings: settings }, resolve);
    });

    return shouldRefresh;
  } catch (_) {
    return false;
  }
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
      resolve('zh_CN');
      return;
    }
    browserAPI.storage.local.get(['preferredLang'], (data) => {
      resolve(data.preferredLang || 'zh_CN');
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

  const rowRecords = document.createElement('div');
  rowRecords.className = 'shortcuts-row';
  const labelRecords = document.createElement('span');
  labelRecords.textContent = getPopupText('shortcutsRecords', lang);
  const keyRecords = document.createElement('kbd');
  keyRecords.textContent = popupShortcuts.records;
  rowRecords.appendChild(labelRecords);
  rowRecords.appendChild(keyRecords);

  const rowRecommend = document.createElement('div');
  rowRecommend.className = 'shortcuts-row';
  const labelRecommend = document.createElement('span');
  labelRecommend.textContent = getPopupText('shortcutsRecommend', lang);
  const keyRecommend = document.createElement('kbd');
  keyRecommend.textContent = popupShortcuts.recommend;
  rowRecommend.appendChild(labelRecommend);
  rowRecommend.appendChild(keyRecommend);

  list.appendChild(rowRecords);
  list.appendChild(rowRecommend);
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

async function updateTrackingWidget() {
  const list = document.getElementById('popupTrackingList');
  const emptyText = document.getElementById('popupTrackingEmptyText');
  if (!list || !browserAPI?.runtime?.sendMessage) return;
  if (emptyText) emptyText.textContent = getPopupText('trackingEmpty', popupRecommendLang);
  list.innerHTML = `<div class="time-tracking-widget-empty"><span>${getPopupText('trackingEmpty', popupRecommendLang)}</span></div>`;

  try {
    const response = await browserAPI.runtime.sendMessage({ action: 'getCurrentActiveSessions' });
    if (!response?.success || !Array.isArray(response.sessions) || response.sessions.length === 0) {
      list.innerHTML = `<div class="time-tracking-widget-empty"><span>${getPopupText('trackingEmpty', popupRecommendLang)}</span></div>`;
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

    list.innerHTML = '';
    const maxShow = 5;
    const showItems = displayItems.slice(0, maxShow);
    const remaining = displayItems.length - maxShow;

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
  } catch (_) {
    list.innerHTML = `<div class="time-tracking-widget-empty"><span>${getPopupText('trackingEmpty', popupRecommendLang)}</span></div>`;
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

  list.innerHTML = `<div class="time-tracking-widget-empty"><span>${getPopupText('widgetLoading', popupRecommendLang)}</span></div>`;
  const bookmarkMap = await loadBookmarkUrlMap();
  if (!bookmarkMap.size) {
    list.innerHTML = `<div class="time-tracking-widget-empty"><span>${getPopupText('rankingEmpty', popupRecommendLang)}</span></div>`;
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

  list.innerHTML = '';
  if (!top.length) {
    list.innerHTML = `<div class="time-tracking-widget-empty"><span>${getPopupText('rankingEmpty', popupRecommendLang)}</span></div>`;
    return;
  }

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
      `${urlObj.protocol}//${domain}/favicon.ico`,
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
      const priority = calculatePopupPriorityWithReview(basePriority, b.id, reviewData, postponedList);
      return { ...b, priority };
    });

    candidates.sort((a, b) => {
      const diff = b.priority - a.priority;
      if (Math.abs(diff) < 0.01) return Math.random() - 0.5;
      return diff;
    });

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
        resolve(response?.success || false);
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
  card.dataset.bookmarkId = '';

  const titleEl = card.querySelector('.popup-recommend-title');
  if (titleEl) titleEl.textContent = message;
  const priorityEl = card.querySelector('.popup-recommend-priority');
  if (priorityEl) priorityEl.textContent = 'S = --';
  const favicon = card.querySelector('.popup-recommend-favicon');
  if (favicon) favicon.src = getRecentFaviconFallback();

  card.onclick = null;
  card.querySelectorAll('.popup-card-btn').forEach(btn => { btn.onclick = null; });
}

async function openPopupRecommendTarget(url) {
  if (!url) return;
  await safeCreateTab({ url });
}

function populatePopupRecommendCard(card, bookmark, cachedFaviconUrl = null) {
  card.classList.remove('empty');
  card.classList.remove('flipped');
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
    priorityEl.textContent = `S = ${bookmark.priority.toFixed(2)}`;
  }

  card.onclick = async (event) => {
    if (event.target.closest('.popup-recommend-actions')) return;
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
          await requestComputeScores();
          scoresCache = await getPopupScoresCache();
        }

        popupRecommendCards = currentCards.cardIds.map(id => {
          const bookmark = bookmarkMap.get(id);
          if (bookmark) {
            const cached = scoresCache[id];
            const cachedData = cachedCardDataMap.get(id);
            const safeTitle = bookmark.title || bookmark.name || cachedData?.title || '';
            const safeUrl = bookmark.url || cachedData?.url || '';
            const basePriority = cached ? cached.S : (cachedData?.priority || 0.5);
            const priority = calculatePopupPriorityWithReview(basePriority, id, reviewData, postponedList);
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
      await requestComputeScores();
      scoresCache = await getPopupScoresCache();
    }

    const bookmarksWithPriority = availableBookmarks.map(b => {
      const cached = scoresCache[b.id];
      const basePriority = cached ? cached.S : 0.5;
      const priority = calculatePopupPriorityWithReview(basePriority, b.id, reviewData, postponedList);
      return { ...b, priority, factors: cached || {} };
    });

    bookmarksWithPriority.sort((a, b) => {
      if (b.priority === a.priority) return Math.random() - 0.5;
      return b.priority - a.priority;
    });

    popupRecommendCards = bookmarksWithPriority.slice(0, POPUP_RECOMMEND_CARD_COUNT);
    const prefetchList = bookmarksWithPriority
      .slice(0, POPUP_RECOMMEND_CARD_COUNT + 6)
      .map(item => item.url)
      .filter(Boolean);
    prefetchPopupFavicons(prefetchList);
    const newCardIds = popupRecommendCards.map(b => b.id);
    const cardData = popupRecommendCards.map(b => ({
      id: b.id,
      title: b.title || '',
      url: b.url,
      favicon: null,
      priority: b.priority
    }));
    await savePopupCurrentCards(newCardIds, [], cardData);
    updatePopupCardDataFavicons(popupRecommendCards);

    cards.forEach((card, index) => {
      const bookmark = popupRecommendCards[index];
      if (bookmark) {
        populatePopupRecommendCard(card, bookmark, null);
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
  }
}

function updatePopupLanguage(lang) {
  popupRecommendLang = lang || 'zh_CN';
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
      const nextLang = changes.preferredLang.newValue || 'zh_CN';
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
    updatePopupLanguage(lang || 'zh_CN');
    return loadPopupShortcuts();
  }).then(() => {
    updatePopupLanguage(popupRecommendLang);
    refreshPopupRecommendCards();
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
