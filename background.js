// Minimal background for Bookmark Record & Recommend extension (MV3)

import {
  initialize as initializeActiveTimeTracker,
  setupEventListeners as setupActiveTimeTrackerListeners,
  setTrackingEnabled,
  isTrackingEnabled,
  noteAutoBookmarkNavigation,
  getCurrentActiveSessions,
  getSessionsByTimeRange,
  getTrackingStats,
  clearTrackingDisplayData,
  clearCurrentTrackingSessions,
  clearTrackingStatsByRange,
  syncTrackingData,
  restoreActiveSessionsFromStorage
} from './active_time_tracker/index.js';
const browserAPI = (function () {
  if (typeof chrome !== 'undefined') return chrome;
  if (typeof browser !== 'undefined') return browser;
  throw new Error('Unsupported browser');
})();

function normalizeHistoryPanelView(view, fallback = 'widgets') {
  if (view === 'widgets' || view === 'recommend' || view === 'additions') {
    return view;
  }
  return fallback;
}

function openView(view) {
  const safeView = normalizeHistoryPanelView(view, 'widgets');
  try {
    browserAPI.storage.local.set({
      historyRequestedView: { view: safeView, time: Date.now() }
    }, () => {});
  } catch (_) {}
  const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
  const url = `${baseUrl}?view=${safeView}`;
  browserAPI.tabs.create({ url });
}

function initSidePanel() {
  if (!browserAPI?.sidePanel) return;
  try {
    if (browserAPI.sidePanel.setPanelBehavior) {
      browserAPI.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }, () => {});
    }
  } catch (_) {}
}

async function getCurrentWindowIdAsync() {
  return await new Promise((resolve) => {
    try {
      if (!browserAPI?.windows?.getCurrent) {
        resolve(null);
        return;
      }
      browserAPI.windows.getCurrent((win) => {
        resolve(win && typeof win.id === 'number' ? win.id : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function resolveWindowIdForSidePanelAction(message, sender) {
  const requestedWindowId = Number(message && message.windowId);
  if (Number.isFinite(requestedWindowId) && requestedWindowId >= 0) {
    return requestedWindowId;
  }
  const senderWindowId = sender && sender.tab && typeof sender.tab.windowId === 'number'
    ? sender.tab.windowId
    : null;
  if (senderWindowId != null) return senderWindowId;
  return await getCurrentWindowIdAsync();
}

async function openSidePanelInWindow(windowId, view = null) {
  if (typeof windowId !== 'number') {
    return { success: false, error: 'window_unavailable' };
  }
  if (typeof browserAPI?.sidePanel?.open !== 'function') {
    return { success: false, error: 'open_unavailable' };
  }

  const safeView = normalizeHistoryPanelView(view, '');
  if (safeView) {
    try {
      browserAPI.storage.local.set({
        historyRequestedView: { view: safeView, time: Date.now() }
      }, () => {});
    } catch (_) {}
  }

  return await new Promise((resolve) => {
    try {
      browserAPI.sidePanel.open({ windowId }, () => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          resolve({ success: false, error: err.message || 'open_failed' });
          return;
        }
        setSidePanelOpenWindowState(windowId, true);
        resolve({ success: true, isOpen: true });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || 'open_failed' });
    }
  });
}

const SIDE_PANEL_CONTEXT = browserAPI?.runtime?.ContextType?.SIDE_PANEL || 'SIDE_PANEL';
const SIDE_PANEL_TOGGLE_PORT = 'bookmark-record-recommend-sidepanel-toggle-v1';
const sidePanelOpenWindows = new Set();
const sidePanelTogglePortsByWindow = new Map();
const sidePanelToggleUnboundPorts = new Set();
let sidePanelTogglePortListenerRegistered = false;

function setSidePanelOpenWindowState(windowId, isOpen) {
  if (typeof windowId !== 'number') return;
  if (isOpen) {
    sidePanelOpenWindows.add(windowId);
    return;
  }
  sidePanelOpenWindows.delete(windowId);
}

function addUnboundSidePanelTogglePort(port) {
  if (!port) return;
  sidePanelToggleUnboundPorts.add(port);
}

function removeUnboundSidePanelTogglePort(port) {
  if (!port) return;
  sidePanelToggleUnboundPorts.delete(port);
}

function addSidePanelTogglePort(windowId, port) {
  if (typeof windowId !== 'number' || !port) return;
  removeUnboundSidePanelTogglePort(port);
  let windowPorts = sidePanelTogglePortsByWindow.get(windowId);
  if (!windowPorts) {
    windowPorts = new Set();
    sidePanelTogglePortsByWindow.set(windowId, windowPorts);
  }
  windowPorts.add(port);
}

function cleanupWindowPortSetIfEmpty(windowId, windowPorts) {
  if (!windowPorts || windowPorts.size !== 0) return;
  sidePanelTogglePortsByWindow.delete(windowId);
}

function removeSidePanelTogglePort(windowId, port) {
  if (typeof windowId !== 'number' || !port) return;
  const windowPorts = sidePanelTogglePortsByWindow.get(windowId);
  if (!windowPorts) return;
  windowPorts.delete(port);
  cleanupWindowPortSetIfEmpty(windowId, windowPorts);
}

function removeSidePanelTogglePortEverywhere(port) {
  if (!port) return;
  removeUnboundSidePanelTogglePort(port);
  for (const [windowId, windowPorts] of Array.from(sidePanelTogglePortsByWindow.entries())) {
    if (!windowPorts.has(port)) continue;
    windowPorts.delete(port);
    cleanupWindowPortSetIfEmpty(windowId, windowPorts);
  }
}

function registerSidePanelTogglePortListener() {
  if (sidePanelTogglePortListenerRegistered) return;
  if (!browserAPI?.runtime?.onConnect?.addListener) return;
  sidePanelTogglePortListenerRegistered = true;

  browserAPI.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== SIDE_PANEL_TOGGLE_PORT) return;

    let trackedWindowId = null;
    addUnboundSidePanelTogglePort(port);

    const updateTrackedWindowId = (windowId) => {
      if (typeof windowId !== 'number') return;
      if (trackedWindowId === windowId) return;
      if (typeof trackedWindowId === 'number') {
        removeSidePanelTogglePort(trackedWindowId, port);
      }
      trackedWindowId = windowId;
      addSidePanelTogglePort(trackedWindowId, port);
      setSidePanelOpenWindowState(trackedWindowId, true);
    };

    const senderWindowId = port?.sender?.tab?.windowId;
    if (typeof senderWindowId === 'number') {
      updateTrackedWindowId(senderWindowId);
    }

    const onMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'sidepanel_toggle_bridge_hello') {
        updateTrackedWindowId(message.windowId);
        try {
          port.postMessage({ type: 'sidepanel_toggle_bridge_ack', ts: Date.now() });
        } catch (_) { }
      }
    };

    const onDisconnect = () => {
      try {
        const err = browserAPI?.runtime?.lastError;
        if (err && err.message) {
          // touch lastError to avoid unchecked runtime.lastError noise.
        }
      } catch (_) { }

      if (typeof trackedWindowId === 'number') {
        setSidePanelOpenWindowState(trackedWindowId, false);
      }
      removeSidePanelTogglePortEverywhere(port);
      try {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      } catch (_) { }
    };

    try {
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    } catch (_) { }

    try {
      port.postMessage({ type: 'sidepanel_toggle_bridge_request_window_id', ts: Date.now() });
    } catch (_) { }
  });

  if (browserAPI?.windows?.onRemoved?.addListener) {
    browserAPI.windows.onRemoved.addListener((windowId) => {
      if (typeof windowId !== 'number') return;
      sidePanelTogglePortsByWindow.delete(windowId);
      setSidePanelOpenWindowState(windowId, false);
    });
  }
}

async function getSidePanelContexts() {
  if (!browserAPI?.runtime?.getContexts) return null;
  try {
    const filter = { contextTypes: [SIDE_PANEL_CONTEXT] };
    const result = browserAPI.runtime.getContexts(filter);
    if (result && typeof result.then === 'function') {
      return await result;
    }
    return await new Promise((resolve) => {
      try {
        browserAPI.runtime.getContexts(filter, (contexts) => {
          resolve(Array.isArray(contexts) ? contexts : []);
        });
      } catch (_) {
        resolve([]);
      }
    });
  } catch (_) {
    return null;
  }
}

async function refreshSidePanelOpenWindows() {
  const contexts = await getSidePanelContexts();
  if (!Array.isArray(contexts)) return null;
  sidePanelOpenWindows.clear();
  contexts.forEach((ctx) => {
    if (ctx && typeof ctx.windowId === 'number') {
      setSidePanelOpenWindowState(ctx.windowId, true);
    }
  });
  return contexts;
}

async function getSidePanelOpenStateForWindow(windowId) {
  if (typeof windowId !== 'number') return false;
  const contexts = await refreshSidePanelOpenWindows();
  if (Array.isArray(contexts) && sidePanelOpenWindows.has(windowId)) {
    return true;
  }

  const windowPorts = sidePanelTogglePortsByWindow.get(windowId);
  if (windowPorts && windowPorts.size > 0) {
    return true;
  }

  return sidePanelOpenWindows.has(windowId);
}

async function closeSidePanelInWindow(windowId) {
  if (typeof windowId !== 'number') {
    return { success: false, error: 'window_unavailable' };
  }
  if (typeof browserAPI?.sidePanel?.close !== 'function') {
    return { success: false, error: 'close_unavailable' };
  }

  return await new Promise((resolve) => {
    try {
      browserAPI.sidePanel.close({ windowId }, () => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          resolve({ success: false, error: err.message || 'close_failed' });
          return;
        }
        setSidePanelOpenWindowState(windowId, false);
        resolve({ success: true, isOpen: false });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || 'close_failed' });
    }
  });
}

if (browserAPI?.runtime?.onInstalled) {
  browserAPI.runtime.onInstalled.addListener(() => {
    initSidePanel();
    refreshSidePanelOpenWindows().catch(() => {});
  });
}

initSidePanel();
registerSidePanelTogglePortListener();
refreshSidePanelOpenWindows().catch(() => {});

if (browserAPI.commands && browserAPI.commands.onCommand) {
  browserAPI.commands.onCommand.addListener((command) => {
    if (command === 'open_additions_view') openView('additions');
    if (command === 'open_recommend_view') openView('recommend');
  });
}

// Initialize active time tracker
(async () => {
  try {
    await initializeActiveTimeTracker();
    setupActiveTimeTrackerListeners();
    try {
      await restoreActiveSessionsFromStorage();
    } catch (_) {}
  } catch (e) {
    console.warn('[ActiveTime] init failed:', e);
  }
})();

// Auto-bookmark attribution (auto_bookmark transition)
const PENDING_AUTO_BOOKMARK_CLICKS_KEY = 'bb_pending_auto_bookmark_clicks_v1';
const PENDING_AUTO_BOOKMARK_CLICKS_MAX = 5000;
const PENDING_AUTO_BOOKMARK_CLICKS_KEEP_MS = 400 * 24 * 60 * 60 * 1000; // ~400 days

async function appendPendingAutoBookmarkClick(event) {
  try {
    const result = await browserAPI.storage.local.get([PENDING_AUTO_BOOKMARK_CLICKS_KEY]);
    const existing = result[PENDING_AUTO_BOOKMARK_CLICKS_KEY];
    const list = Array.isArray(existing) ? existing : [];

    list.push(event);

    const now = Date.now();
    const cutoff = now - PENDING_AUTO_BOOKMARK_CLICKS_KEEP_MS;
    const pruned = list
      .filter(e => e && typeof e.visitTime === 'number' && e.visitTime >= cutoff)
      .slice(-PENDING_AUTO_BOOKMARK_CLICKS_MAX);

    await browserAPI.storage.local.set({ [PENDING_AUTO_BOOKMARK_CLICKS_KEY]: pruned });
  } catch (error) {
    console.warn('[AutoBookmarkOpen] failed to write pending clicks:', error);
  }
}

function setupAutoBookmarkOpenMonitoring() {
  try {
    if (!browserAPI.webNavigation || !browserAPI.webNavigation.onCommitted) return;

    browserAPI.webNavigation.onCommitted.addListener(async (details) => {
      try {
        if (!details || details.frameId !== 0) return;
        if (details.transitionType !== 'auto_bookmark') return;

        const url = details.url;
        if (!url || (typeof url !== 'string')) return;
        if (!url.startsWith('http://') && !url.startsWith('https://')) return;

        let bookmarkId = null;
        let bookmarkTitle = '';

        try {
          const matches = await browserAPI.bookmarks.search({ url });
          if (Array.isArray(matches) && matches.length > 0) {
            bookmarkId = matches[0].id || null;
            bookmarkTitle = matches[0].title || '';
          }
        } catch (_) {}

        if (!bookmarkTitle) {
          try {
            const tab = await browserAPI.tabs.get(details.tabId);
            bookmarkTitle = tab?.title || '';
          } catch (_) {}
        }

        noteAutoBookmarkNavigation({
          tabId: details.tabId,
          bookmarkUrl: url,
          bookmarkId,
          bookmarkTitle,
          timeStamp: typeof details.timeStamp === 'number' ? details.timeStamp : Date.now(),
          source: 'browser_auto_bookmark'
        });
      } catch (error) {
        console.warn('[AutoBookmarkOpen] failed to handle event:', error);
      }
    });
  } catch (error) {
    console.warn('[AutoBookmarkOpen] init failed:', error);
  }
}

setupAutoBookmarkOpenMonitoring();

// =================================================================================
// Browsing history calibration (background)
// =================================================================================

const BROWSING_HISTORY_CACHE_KEY = 'bb_cache_browsing_history_v1';
const BROWSING_HISTORY_CACHE_DB_NAME = 'BookmarkBrowsingHistoryCacheDB';
const BROWSING_HISTORY_CACHE_DB_VERSION = 1;
const BROWSING_HISTORY_CACHE_DB_STORE = 'records';
const BROWSING_HISTORY_CACHE_DB_META = 'meta';
const BROWSING_HISTORY_SEARCH_PAGE_SIZE = 5000;
const BROWSING_HISTORY_SEARCH_MAX_ITEMS = 50000;
const BROWSING_HISTORY_MAX_VISITS_PER_URL = 400;
const BROWSING_HISTORY_LOOKBACK_DAYS = 0;

const BROWSING_CALIBRATION_SETTINGS_KEY = 'browsingCalibrationSettings';
const BROWSING_CALIBRATION_STATE_KEY = 'browsingCalibrationState';
const DEFAULT_BROWSING_CALIBRATION_SETTINGS = {
  autoEnabled: true,
  deleteThreshold: 15,
  openThreshold: 0
};
const DEFAULT_BROWSING_CALIBRATION_STATE = {
  pendingDeleteCount: 0,
  pendingOpenCount: 0,
  lastCalibrationTime: 0,
  lastDeletionTime: 0,
  lastOpenTime: 0
};

let browsingCalibrationInProgress = false;
let browsingHistoryCacheDbPromise = null;

function normalizeBrowsingCalibrationSettings(raw = {}) {
  const settings = { ...DEFAULT_BROWSING_CALIBRATION_SETTINGS, ...(raw || {}) };
  const hasDelete = Object.prototype.hasOwnProperty.call(raw || {}, 'deleteThreshold');
  const hasOpen = Object.prototype.hasOwnProperty.call(raw || {}, 'openThreshold');
  const hasClick = Object.prototype.hasOwnProperty.call(raw || {}, 'clickThreshold');
  const hasAutoEnabled = Object.prototype.hasOwnProperty.call(raw || {}, 'autoEnabled');
  const autoDisabled = hasAutoEnabled ? raw.autoEnabled === false : false;

  if (!hasOpen && hasClick) {
    settings.openThreshold = raw.clickThreshold;
  }

  if (raw && autoDisabled) {
    if (!hasDelete) settings.deleteThreshold = 0;
    if (!hasOpen && !hasClick) settings.openThreshold = 0;
  }

  settings.deleteThreshold = Math.max(0, Number(settings.deleteThreshold) || 0);
  settings.openThreshold = Math.max(0, Number(settings.openThreshold) || 0);
  return settings;
}

function getCalibrationThresholds(settings) {
  return {
    deleteThreshold: Math.max(0, Number(settings.deleteThreshold) || 0),
    openThreshold: Math.max(0, Number(settings.openThreshold) || 0)
  };
}

function isAutoCalibrationEnabled(settings, thresholds) {
  if (settings && settings.autoEnabled === false) return false;
  return (thresholds.deleteThreshold > 0 || thresholds.openThreshold > 0);
}

function normalizeHistoryDomain(domain) {
  if (!domain) return '';
  return String(domain).toLowerCase().replace(/^www\./, '');
}

function getHistoryUrlDomain(url) {
  if (!url) return '';
  try {
    return normalizeHistoryDomain(new URL(url).hostname);
  } catch (_) {
    return '';
  }
}

function getHistoryDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function openBrowsingHistoryCacheDB() {
  if (browsingHistoryCacheDbPromise) return browsingHistoryCacheDbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  browsingHistoryCacheDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(BROWSING_HISTORY_CACHE_DB_NAME, BROWSING_HISTORY_CACHE_DB_VERSION);
    request.onerror = () => {
      console.warn('[Background][HistoryCache] open DB failed:', request.error);
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(BROWSING_HISTORY_CACHE_DB_STORE)) {
        db.createObjectStore(BROWSING_HISTORY_CACHE_DB_STORE, { keyPath: 'dateKey' });
      }
      if (!db.objectStoreNames.contains(BROWSING_HISTORY_CACHE_DB_META)) {
        db.createObjectStore(BROWSING_HISTORY_CACHE_DB_META, { keyPath: 'key' });
      }
    };
  });
  return browsingHistoryCacheDbPromise;
}

async function removeBrowsingHistoryCacheFromIDB() {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
    tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE).clear();
    tx.objectStore(BROWSING_HISTORY_CACHE_DB_META).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function writeBrowsingHistoryCacheToIDB(payload) {
  if (!payload || !Array.isArray(payload.records)) return false;
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
    const recordsStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
    const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
    try {
      for (const [dateKey, items] of payload.records) {
        if (!dateKey) continue;
        recordsStore.put({ dateKey, items: Array.isArray(items) ? items : [] });
      }
      metaStore.put({ key: 'lastSyncTime', value: payload.lastSyncTime || Date.now() });
    } catch (error) {
      console.warn('[Background][HistoryCache] write DB failed:', error);
      resolve(false);
      return;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function writeBrowsingHistoryCache(payload) {
  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    await removeBrowsingHistoryCacheFromIDB();
    const ok = await writeBrowsingHistoryCacheToIDB(payload);
    if (ok) return true;
  }
  try {
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] write storage failed:', error);
    return false;
  }
}

async function resetBrowsingHistoryCache(lastSyncTime) {
  const payload = {
    lastSyncTime: lastSyncTime || Date.now(),
    records: []
  };
  await writeBrowsingHistoryCache(payload);
}

async function getBrowsingCalibrationSettingsBG() {
  try {
    const result = await browserAPI.storage.local.get([BROWSING_CALIBRATION_SETTINGS_KEY]);
    return normalizeBrowsingCalibrationSettings(
      result && result[BROWSING_CALIBRATION_SETTINGS_KEY]
        ? result[BROWSING_CALIBRATION_SETTINGS_KEY]
        : {}
    );
  } catch (error) {
    console.warn('[Background][Calibration] settings read failed:', error);
    return normalizeBrowsingCalibrationSettings({});
  }
}

async function getBrowsingCalibrationState() {
  try {
    const result = await browserAPI.storage.local.get([BROWSING_CALIBRATION_STATE_KEY]);
    const stored = result && result[BROWSING_CALIBRATION_STATE_KEY]
      ? result[BROWSING_CALIBRATION_STATE_KEY]
      : {};
    const merged = {
      ...DEFAULT_BROWSING_CALIBRATION_STATE,
      ...stored
    };
    if (stored && stored.pendingClickCount) {
      const clickCount = Number(stored.pendingClickCount) || 0;
      merged.pendingOpenCount = (merged.pendingOpenCount || 0) + clickCount;
    }
    if (stored && stored.lastClickTime) {
      const lastClick = Number(stored.lastClickTime) || 0;
      if (!merged.lastOpenTime || lastClick > merged.lastOpenTime) {
        merged.lastOpenTime = lastClick;
      }
    }
    delete merged.pendingClickCount;
    delete merged.lastClickTime;
    return merged;
  } catch (error) {
    console.warn('[Background][Calibration] state read failed:', error);
    return { ...DEFAULT_BROWSING_CALIBRATION_STATE };
  }
}

async function saveBrowsingCalibrationState(state) {
  try {
    await browserAPI.storage.local.set({ [BROWSING_CALIBRATION_STATE_KEY]: state });
  } catch (error) {
    console.warn('[Background][Calibration] state save failed:', error);
  }
}

async function resetBrowsingCalibrationState(reason = 'manual') {
  const state = await getBrowsingCalibrationState();
  const nextState = {
    ...state,
    pendingDeleteCount: 0,
    pendingOpenCount: 0,
    lastCalibrationTime: Date.now()
  };
  await saveBrowsingCalibrationState(nextState);

}

function collectBookmarkUrlsAndTitles(node, urlSet, titleSet, parentPath = [], titleDomainMap = null) {
  if (!node) return;
  if (node.url) {
    urlSet.add(node.url);
    if (node.title && node.title.trim()) {
      const trimmedTitle = node.title.trim();
      titleSet.add(trimmedTitle);
      if (titleDomainMap) {
        const domain = getHistoryUrlDomain(node.url);
        if (domain) {
          let domains = titleDomainMap.get(trimmedTitle);
          if (!domains) {
            domains = new Set();
            titleDomainMap.set(trimmedTitle, domains);
          }
          domains.add(domain);
        }
      }
    }
  }
  if (node.children) {
    const currentPath = node.title ? [...parentPath, node.title] : parentPath;
    node.children.forEach(child => collectBookmarkUrlsAndTitles(child, urlSet, titleSet, currentPath, titleDomainMap));
  }
}

function addVisitRecord(recordsByDate, visitKeySet, item, visitTime, options = {}, cutoffTime = 0) {
  if (!item || !item.url || !visitTime) return false;
  if (cutoffTime && visitTime < cutoffTime) return false;
  const visitKey = `${item.url}|${visitTime}`;
  if (visitKeySet.has(visitKey)) return false;
  visitKeySet.add(visitKey);
  const dateKey = getHistoryDateKey(visitTime);
  if (!recordsByDate.has(dateKey)) {
    recordsByDate.set(dateKey, []);
  }
  const records = recordsByDate.get(dateKey);
  records.push({
    id: options.id || `${item.id || item.url}-${visitTime}-${records.length}`,
    title: item.title || item.url,
    url: item.url,
    dateAdded: visitTime,
    visitTime,
    visitCount: typeof options.count === 'number' && options.count > 0 ? options.count : 1,
    typedCount: item.typedCount || 0,
    folderPath: [],
    transition: options.transition || '',
    referringVisitId: options.referringVisitId || null,
    aggregated: !!options.aggregated
  });
  return true;
}

async function rebuildBrowsingHistoryCache(reason = 'auto') {
  if (!browserAPI.history || !browserAPI.history.search || !browserAPI.bookmarks) return false;

  const bookmarks = await browserAPI.bookmarks.getTree();
  const bookmarkUrls = new Set();
  const bookmarkTitles = new Set();
  const titleDomainMap = new Map();
  if (Array.isArray(bookmarks) && bookmarks[0]) {
    collectBookmarkUrlsAndTitles(bookmarks[0], bookmarkUrls, bookmarkTitles, [], titleDomainMap);
  }

  const now = Date.now();
  const lookbackMs = (typeof BROWSING_HISTORY_LOOKBACK_DAYS === 'number' && BROWSING_HISTORY_LOOKBACK_DAYS > 0)
    ? BROWSING_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    : 0;
  const cutoffTime = lookbackMs ? (now - lookbackMs) : 0;

  if (bookmarkUrls.size === 0) {
    await resetBrowsingHistoryCache(now);
    return true;
  }

  const fetchHistoryBatch = (startTime, endTime) => new Promise((resolve) => {
    browserAPI.history.search({
      text: '',
      startTime,
      endTime,
      maxResults: BROWSING_HISTORY_SEARCH_PAGE_SIZE
    }, (results) => resolve(results || []));
  });

  const historyItems = [];
  let pageEnd = now;
  const effectiveStartTime = cutoffTime || 0;

  while (pageEnd >= effectiveStartTime) {
    const batch = await fetchHistoryBatch(effectiveStartTime, pageEnd);
    if (!batch.length) break;

    historyItems.push(...batch);
    if (historyItems.length >= BROWSING_HISTORY_SEARCH_MAX_ITEMS) {
      historyItems.length = BROWSING_HISTORY_SEARCH_MAX_ITEMS;
      break;
    }

    if (batch.length < BROWSING_HISTORY_SEARCH_PAGE_SIZE) break;

    let oldest = pageEnd;
    for (const item of batch) {
      const t = item.lastVisitTime || pageEnd;
      if (t < oldest) oldest = t;
    }
    if (!oldest || oldest <= effectiveStartTime) break;
    pageEnd = oldest - 1;
  }

  const relevantHistoryItems = historyItems.filter(item => {
    if (!item || !item.url) return false;
    if (bookmarkUrls.has(item.url)) return true;
    const title = item.title && item.title.trim();
    if (title && bookmarkTitles.has(title)) {
      const allowedDomains = titleDomainMap.get(title);
      if (allowedDomains && allowedDomains.size > 0) {
        const itemDomain = getHistoryUrlDomain(item.url);
        if (itemDomain && allowedDomains.has(itemDomain)) {
          return true;
        }
      }
    }
    return false;
  });

  if (!relevantHistoryItems.length) {
    await resetBrowsingHistoryCache(now);
    return true;
  }

  const recordsByDate = new Map();
  const visitKeySet = new Set();
  const hasVisitDetails = browserAPI.history && typeof browserAPI.history.getVisits === 'function';

  const getVisitsAsync = (item) => new Promise((resolve) => {
    try {
      browserAPI.history.getVisits({ url: item.url }, (visits) => resolve(visits || []));
    } catch (_) {
      resolve([]);
    }
  });

  if (!hasVisitDetails) {
    relevantHistoryItems.forEach(item => {
      const fallbackTime = item.lastVisitTime || 0;
      if (!fallbackTime) return;
      addVisitRecord(recordsByDate, visitKeySet, item, fallbackTime, {
        count: Math.max(item.visitCount || 1, 1),
        aggregated: true,
        id: item.id || item.url
      }, cutoffTime);
    });
  } else {
    const concurrency = Math.max(1, Math.min(8, relevantHistoryItems.length));
    let cursor = 0;

    const processNext = async () => {
      while (cursor < relevantHistoryItems.length) {
        const currentIndex = cursor++;
        const item = relevantHistoryItems[currentIndex];
        if (!item || !item.url) continue;

        const visits = await getVisitsAsync(item);
        let inserted = 0;

        if (Array.isArray(visits) && visits.length) {
          for (const visit of visits) {
            const visitTime = typeof visit.visitTime === 'number' ? visit.visitTime : 0;
            if (!visitTime) continue;
            if (addVisitRecord(recordsByDate, visitKeySet, item, visitTime, {
              id: `${item.id || item.url}-${visit.visitId || visitTime}-${inserted}`,
              transition: visit.transition || '',
              referringVisitId: visit.referringVisitId || null,
              count: 1
            }, cutoffTime)) {
              inserted += 1;
            }
            if (BROWSING_HISTORY_MAX_VISITS_PER_URL && inserted >= BROWSING_HISTORY_MAX_VISITS_PER_URL) {
              break;
            }
          }
        }

        if (inserted === 0 && item.lastVisitTime) {
          addVisitRecord(recordsByDate, visitKeySet, item, item.lastVisitTime, {
            count: Math.max(item.visitCount || 1, 1),
            aggregated: true,
            id: item.id || item.url
          }, cutoffTime);
        }

        if (cursor % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => processNext()));
  }

  const recordsPayload = [];
  for (const [dateKey, items] of recordsByDate.entries()) {
    const normalizedItems = items.map(record => ({
      ...record,
      dateAdded: typeof record.dateAdded === 'number' ? record.dateAdded : (record.visitTime || Date.now())
    }));
    recordsPayload.push([dateKey, normalizedItems]);
  }

  await writeBrowsingHistoryCache({
    lastSyncTime: now,
    records: recordsPayload
  });


  return true;
}

async function runBrowsingHistoryCalibration({ reason = 'auto', clearOnly = false } = {}) {
  if (browsingCalibrationInProgress) return false;
  browsingCalibrationInProgress = true;
  try {
    if (clearOnly) {
      await resetBrowsingHistoryCache(Date.now());
      try {
        browserAPI.runtime.sendMessage({
          action: 'browsingCalibrationCompleted',
          payload: { reason, clearOnly: true }
        }).catch(() => {});
      } catch (_) { }
      return true;
    }
    const ok = await rebuildBrowsingHistoryCache(reason);
    if (ok) {
      try {
        browserAPI.runtime.sendMessage({
          action: 'browsingCalibrationCompleted',
          payload: { reason, clearOnly: false }
        }).catch(() => {});
      } catch (_) { }
    }
    return ok;
  } catch (error) {
    console.warn('[Background][Calibration] failed:', error);
    return false;
  } finally {
    browsingCalibrationInProgress = false;
  }
}

async function maybeRunBrowsingHistoryCalibration({ settings, nextState, reason = 'auto' } = {}) {
  const thresholds = getCalibrationThresholds(settings || {});
  if (!isAutoCalibrationEnabled(settings || {}, thresholds)) return false;

  let trigger = null;
  if (thresholds.deleteThreshold > 0 && nextState.pendingDeleteCount >= thresholds.deleteThreshold) {
    trigger = 'delete';
  } else if (thresholds.openThreshold > 0 && nextState.pendingOpenCount >= thresholds.openThreshold) {
    trigger = 'open';
  }

  if (!trigger) return false;

  const ok = await runBrowsingHistoryCalibration({ reason: `${reason}-${trigger}-threshold` });
  if (ok) {
    nextState.pendingDeleteCount = 0;
    nextState.pendingOpenCount = 0;
    nextState.lastCalibrationTime = Date.now();
  }
  return ok;
}

async function recordDeletionForCalibration({ source = 'unknown', urlCount = 0, hasUrlList = true, allHistory = false } = {}) {
  const settings = await getBrowsingCalibrationSettingsBG();
  const state = await getBrowsingCalibrationState();
  if (allHistory) {
    await runBrowsingHistoryCalibration({ reason: `${source}-all-history`, clearOnly: true });
    const nextState = {
      ...state,
      pendingDeleteCount: 0,
      pendingOpenCount: 0,
      lastCalibrationTime: Date.now(),
      lastDeletionTime: Date.now()
    };
    await saveBrowsingCalibrationState(nextState);
    return;
  }

  const thresholds = getCalibrationThresholds(settings);
  let increment = 1;
  if (hasUrlList) {
    increment = Math.max(1, Number(urlCount) || 1);
  }
  const nextState = {
    ...state,
    pendingDeleteCount: (state.pendingDeleteCount || 0) + increment,
    lastDeletionTime: Date.now()
  };

  await maybeRunBrowsingHistoryCalibration({ settings, nextState, reason: source });

  await saveBrowsingCalibrationState(nextState);
}

async function recordInteractionForCalibration({ type = 'open', increment = 1, source = 'ui' } = {}) {
  const settings = await getBrowsingCalibrationSettingsBG();
  const state = await getBrowsingCalibrationState();
  const nextState = { ...state };
  const step = Math.max(1, Number(increment) || 1);

  if (type === 'open' || type === 'click') {
    nextState.pendingOpenCount = (state.pendingOpenCount || 0) + step;
    nextState.lastOpenTime = Date.now();
  } else {
    return;
  }

  await maybeRunBrowsingHistoryCalibration({ settings, nextState, reason: source });
  await saveBrowsingCalibrationState(nextState);
}

if (browserAPI.history && browserAPI.history.onVisitRemoved) {
  browserAPI.history.onVisitRemoved.addListener((details) => {
    const urls = Array.isArray(details?.urls) ? details.urls : [];
    recordDeletionForCalibration({
      source: 'history',
      allHistory: !!details?.allHistory,
      urlCount: urls.length,
      hasUrlList: urls.length > 0
    }).catch(() => {});
  });
}

// =================================================================================
// Bookmark Recommend S-score system
// =================================================================================

let isComputingScores = false;
let isBookmarkImporting = false;
let isBookmarkBulkChanging = false;
let bookmarkBulkWindowStart = 0;
let bookmarkBulkEventCount = 0;
let bookmarkBulkExitTimer = null;
let scheduledRecomputeTimer = null;
let lastBulkReason = '';
let bookmarkBulkHasRemoval = false;
let scoreCacheMode = null;
let pendingTemplateRefineIds = new Set();
let templateRefineTimer = null;
let templateRefineRunning = false;
let recommendStateMutationChains = new Map();
let bulkTemplateRecoveryTimer = null;
let recommendScoresReadyPromise = null;
let removedRecommendPruneTimer = null;
let pendingRemovedBookmarkIds = new Set();
let pendingRemovedFolderIds = new Set();

const BOOKMARK_BULK_WINDOW_MS = 800;
const BOOKMARK_BULK_THRESHOLD = 8;
const BOOKMARK_BULK_QUIET_MS = 5000;

const SCORE_ALGO_VERSION_KEY = 'recommend_scores_algo_version';
const SCORE_ALGO_VERSION = 6.2;

const SCORE_CACHE_MODE_KEY = 'recommend_scores_cache_mode';
const SCORE_CACHE_MODE_FULL = 'full';
const SCORE_CACHE_MODE_COMPACT = 'compact';
const SCORE_CACHE_COMPACT_THRESHOLD = 8000;

const SCORE_BOOTSTRAP_THRESHOLD = 1200;
const SCORE_BOOTSTRAP_LIMIT = 600;
const SCORE_INCREMENTAL_BATCH_SIZE = 180;
const SCORE_TEMPLATE_BATCH_THRESHOLD = 800;
const SCORE_TEMPLATE_DEFAULT_S = 0.5;
const SCORE_TEMPLATE_REFINE_DEBOUNCE_MS = 400;
const SCORE_TEMPLATE_REFINE_BATCH_SIZE = 360;
const BULK_TEMPLATE_RECOVERY_DEBOUNCE_MS = 1200;
const REMOVED_RECOMMEND_PRUNE_DEBOUNCE_MS = 900;

const RECOMMEND_SKIPPED_STORAGE_KEY = 'recommend_skipped_bookmarks_v1';
const RECOMMEND_SKIPPED_MAX_ITEMS = 20000;
const RECOMMEND_BLOCKED_STORAGE_KEY = 'recommend_blocked';
const RECOMMEND_POSTPONED_STORAGE_KEY = 'recommend_postponed';
const RECOMMEND_STATE_MUTATION_CHANNEL = 'recommend_state_mutation_v1';
const RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY = 'recommendRefreshSettings';
const HISTORY_CURRENT_CARDS_STORAGE_KEY = 'historyCurrentCards';
const FLIPPED_BOOKMARKS_STORAGE_KEY = 'flippedBookmarks';
const RECOMMEND_POOL_CURSOR_STORAGE_KEY = 'bb_recommend_pool_cursor_v1';
const FLIP_HISTORY_STORAGE_KEY = 'flipHistory';
const HEATMAP_DAILY_INDEX_STORAGE_KEY = 'flipHistoryDailyIndexV1';
const FLIP_HISTORY_MAX_ITEMS = 12000;
const FLIP_HISTORY_RETENTION_DAYS = 420;
const FLIP_HISTORY_DAY_RECORDS_MAX = 300;

const DEFAULT_REFRESH_SETTINGS = {
  refreshEveryNOpens: 3,
  refreshAfterHours: 0,
  refreshAfterDays: 0,
  lastRefreshTime: 0,
  openCountSinceRefresh: 0,
  sidePanelOpenCountSinceRefresh: 0
};

// Tracking cold-start fairness
const TRACKING_WARMUP_MIN_MS = 30 * 60 * 1000; // 30 minutes
const TRACKING_WARMUP_MIN_COUNT = 30; // 30 tracked items
const TRACKING_NEUTRAL_T = 0.5;

async function invalidateRecommendCaches(reason = '') {
  try {
    await browserAPI.storage.local.set({
      recommend_scores_cache: {},
      recommend_scores_time: 0,
      [SCORE_CACHE_MODE_KEY]: SCORE_CACHE_MODE_COMPACT,
      recommendScoresStaleMeta: {
        staleAt: Date.now(),
        reason: reason || 'unknown'
      }
    });
  } catch (_) { }
  scoreCacheMode = SCORE_CACHE_MODE_COMPACT;

  // 推荐卡片状态依赖 bookmarkId：批量导入/删除/移动后可能大量失效
  try {
    await browserAPI.storage.local.remove([HISTORY_CURRENT_CARDS_STORAGE_KEY, RECOMMEND_POOL_CURSOR_STORAGE_KEY]);
  } catch (_) { }
}

async function ensureScoreAlgoVersion() {
  try {
    const result = await browserAPI.storage.local.get([SCORE_ALGO_VERSION_KEY]);
    if (result?.[SCORE_ALGO_VERSION_KEY] === SCORE_ALGO_VERSION) return;
    await invalidateRecommendCaches(`algo-v${SCORE_ALGO_VERSION}`);
    await browserAPI.storage.local.set({ [SCORE_ALGO_VERSION_KEY]: SCORE_ALGO_VERSION });
  } catch (_) { }
}

ensureScoreAlgoVersion().catch(() => { });

function runSerializedRecommendStateMutation(channel, task) {
  const key = String(channel || RECOMMEND_STATE_MUTATION_CHANNEL);
  const prev = recommendStateMutationChains.get(key) || Promise.resolve();
  const next = prev
    .catch(() => { })
    .then(async () => task());

  recommendStateMutationChains.set(key, next);

  next.finally(() => {
    if (recommendStateMutationChains.get(key) === next) {
      recommendStateMutationChains.delete(key);
    }
  });

  return next;
}

function normalizeRecommendSkippedIds(ids = []) {
  const list = Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)
  ));

  if (list.length <= RECOMMEND_SKIPPED_MAX_ITEMS) {
    return list;
  }
  return list.slice(list.length - RECOMMEND_SKIPPED_MAX_ITEMS);
}

async function getRecommendSkippedIds() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_SKIPPED_STORAGE_KEY]);
    return normalizeRecommendSkippedIds(result?.[RECOMMEND_SKIPPED_STORAGE_KEY] || []);
  } catch (_) {
    return [];
  }
}

async function getRecommendPostponedList() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_POSTPONED_STORAGE_KEY]);
    return Array.isArray(result?.[RECOMMEND_POSTPONED_STORAGE_KEY])
      ? result[RECOMMEND_POSTPONED_STORAGE_KEY]
      : [];
  } catch (_) {
    return [];
  }
}

function normalizeRecommendBlockedState(blocked) {
  const source = blocked && typeof blocked === 'object' ? blocked : {};

  const normalizeIdList = (list) => Array.from(new Set(
    (Array.isArray(list) ? list : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
  ));

  const normalizeDomainList = (list) => Array.from(new Set(
    (Array.isArray(list) ? list : [])
      .map(item => normalizeBlockedDomain(item))
      .filter(Boolean)
  ));

  return {
    bookmarks: normalizeIdList(source.bookmarks),
    folders: normalizeIdList(source.folders),
    domains: normalizeDomainList(source.domains)
  };
}

function normalizeRecommendPostponedList(list) {
  if (!Array.isArray(list)) return [];

  const byBookmarkId = new Map();
  for (const item of list) {
    if (!item || item.bookmarkId == null) continue;
    const bookmarkId = String(item.bookmarkId || '').trim();
    if (!bookmarkId) continue;

    const normalized = {
      ...item,
      bookmarkId
    };

    if (!byBookmarkId.has(bookmarkId)) {
      byBookmarkId.set(bookmarkId, normalized);
      continue;
    }

    const existing = byBookmarkId.get(bookmarkId);
    const existingUpdatedAt = Number(existing?.updatedAt || existing?.createdAt || existing?.addedAt || 0);
    const nextUpdatedAt = Number(normalized?.updatedAt || normalized?.createdAt || normalized?.addedAt || 0);

    if (nextUpdatedAt >= existingUpdatedAt) {
      byBookmarkId.set(bookmarkId, {
        ...existing,
        ...normalized,
        bookmarkId
      });
    }
  }

  return Array.from(byBookmarkId.values());
}

async function getRecommendBlockedState() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_BLOCKED_STORAGE_KEY]);
    return normalizeRecommendBlockedState(result?.[RECOMMEND_BLOCKED_STORAGE_KEY]);
  } catch (_) {
    return normalizeRecommendBlockedState(null);
  }
}

async function setRecommendBlockedState(blocked) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const next = normalizeRecommendBlockedState(blocked);
    await browserAPI.storage.local.set({
      [RECOMMEND_BLOCKED_STORAGE_KEY]: next
    });
    return {
      success: true,
      blocked: next
    };
  });
}

async function setRecommendPostponedState(postponed) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const next = normalizeRecommendPostponedList(postponed);
    await browserAPI.storage.local.set({
      [RECOMMEND_POSTPONED_STORAGE_KEY]: next
    });
    return {
      success: true,
      postponed: next,
      count: next.length
    };
  });
}

async function getAllBookmarkUrlIdsForScore() {
  if (!browserAPI?.bookmarks?.getTree) return [];

  try {
    const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
    const ids = [];

    const traverse = (nodes) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node?.url && node?.id != null) {
          ids.push(String(node.id));
        }
        if (Array.isArray(node?.children) && node.children.length > 0) {
          traverse(node.children);
        }
      }
    };

    traverse(tree);
    return normalizeBookmarkIdList(ids);
  } catch (e) {
    console.warn('[S-score] collect bookmark ids failed:', e);
    return [];
  }
}

async function handleRecommendSkipState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, mode: 'none', skippedIds: [] };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const [rawSkipped, rawPostponed] = await Promise.all([
      getRecommendSkippedIds(),
      getRecommendPostponedList()
    ]);

    const skipped = normalizeRecommendSkippedIds(rawSkipped);
    const postponed = normalizeRecommendPostponedList(rawPostponed);
    const now = Date.now();

    let maxMovedAt = 0;
    for (const item of postponed) {
      if (!item || item.bookmarkId == null || item.manuallyAdded) continue;
      if (Number(item.postponeUntil || 0) > now) continue;
      const movedAt = Number(item.dueQueueMovedAt || 0);
      if (Number.isFinite(movedAt) && movedAt > maxMovedAt) {
        maxMovedAt = movedAt;
      }
    }

    const target = postponed.find((item) => {
      if (!item || item.bookmarkId == null || item.manuallyAdded) return false;
      if (String(item.bookmarkId || '').trim() !== id) return false;
      return Number(item.postponeUntil || 0) <= now;
    });

    if (target) {
      target.dueQueueMovedAt = Math.max(now, maxMovedAt + 1);
      target.updatedAt = now;

      const nextSkipped = skipped.filter(item => item !== id);
      await browserAPI.storage.local.set({
        [RECOMMEND_POSTPONED_STORAGE_KEY]: postponed,
        [RECOMMEND_SKIPPED_STORAGE_KEY]: normalizeRecommendSkippedIds(nextSkipped)
      });

      return {
        success: true,
        mode: 'due-tail',
        skippedIds: normalizeRecommendSkippedIds(nextSkipped),
        dueMoved: true
      };
    }

    const nextSkipped = skipped.filter(item => item !== id);
    nextSkipped.push(id);
    const normalized = normalizeRecommendSkippedIds(nextSkipped);

    await browserAPI.storage.local.set({
      [RECOMMEND_SKIPPED_STORAGE_KEY]: normalized
    });

    return {
      success: true,
      mode: 'skip',
      skippedIds: normalized,
      dueMoved: false
    };
  });
}

async function removeRecommendSkippedState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, skippedIds: [] };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const current = await getRecommendSkippedIds();
    const next = normalizeRecommendSkippedIds(current.filter(item => item !== id));
    await browserAPI.storage.local.set({ [RECOMMEND_SKIPPED_STORAGE_KEY]: next });
    return { success: true, skippedIds: next };
  });
}

function normalizeRefreshOpenSource(source) {
  return source === 'sidepanel' ? 'sidepanel' : 'page';
}

function getRefreshOpenCountField(source) {
  return normalizeRefreshOpenSource(source) === 'sidepanel'
    ? 'sidePanelOpenCountSinceRefresh'
    : 'openCountSinceRefresh';
}

function getRefreshOpenCount(settings, source) {
  const field = getRefreshOpenCountField(source);
  const raw = Number(settings && settings[field]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function setRefreshOpenCount(settings, source, count) {
  const field = getRefreshOpenCountField(source);
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  settings[field] = safeCount;
}

async function getRecommendRefreshSettings() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY]);
    return {
      ...DEFAULT_REFRESH_SETTINGS,
      ...(result?.[RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY] || {})
    };
  } catch (_) {
    return { ...DEFAULT_REFRESH_SETTINGS };
  }
}

async function saveRecommendRefreshSettings(settings) {
  await browserAPI.storage.local.set({ [RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY]: settings });
}

async function recordRecommendViewOpenState(source) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const safeSource = normalizeRefreshOpenSource(source);
    const settings = await getRecommendRefreshSettings();
    const now = Date.now();

    const nextCount = getRefreshOpenCount(settings, safeSource) + 1;
    setRefreshOpenCount(settings, safeSource, nextCount);

    let shouldRefresh = false;
    if (settings.refreshEveryNOpens > 0 && nextCount >= settings.refreshEveryNOpens) {
      shouldRefresh = true;
    }

    if (!shouldRefresh && settings.refreshAfterHours > 0 && settings.lastRefreshTime > 0) {
      const hoursSinceRefresh = (now - settings.lastRefreshTime) / (1000 * 60 * 60);
      if (hoursSinceRefresh >= settings.refreshAfterHours) {
        shouldRefresh = true;
      }
    }

    if (!shouldRefresh && settings.refreshAfterDays > 0 && settings.lastRefreshTime > 0) {
      const daysSinceRefresh = (now - settings.lastRefreshTime) / (1000 * 60 * 60 * 24);
      if (daysSinceRefresh >= settings.refreshAfterDays) {
        shouldRefresh = true;
      }
    }

    const shouldPreloadCandidates = !shouldRefresh
      && settings.refreshEveryNOpens > 1
      && nextCount === settings.refreshEveryNOpens - 1;

    await saveRecommendRefreshSettings(settings);

    return {
      success: true,
      source: safeSource,
      openCount: nextCount,
      shouldRefresh,
      shouldPreloadCandidates,
      settings
    };
  });
}

async function markRecommendRefreshExecutedState() {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const settings = await getRecommendRefreshSettings();
    settings.lastRefreshTime = Date.now();
    settings.openCountSinceRefresh = 0;
    settings.sidePanelOpenCountSinceRefresh = 0;
    await saveRecommendRefreshSettings(settings);
    return { success: true, settings };
  });
}

async function appendRecommendFlippedBookmarkState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, flippedIds: [] };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const result = await browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]);
    const current = Array.isArray(result?.[FLIPPED_BOOKMARKS_STORAGE_KEY])
      ? result[FLIPPED_BOOKMARKS_STORAGE_KEY]
      : [];
    const normalized = normalizeBookmarkIdList(current);
    if (!normalized.includes(id)) {
      normalized.push(id);
      await browserAPI.storage.local.set({ [FLIPPED_BOOKMARKS_STORAGE_KEY]: normalized });
    }
    return { success: true, flippedIds: normalized };
  });
}

async function markHistoryCurrentCardFlippedState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, allFlipped: false, historyCurrentCards: null };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const result = await browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY]);
    const current = result?.[HISTORY_CURRENT_CARDS_STORAGE_KEY];
    if (!current || typeof current !== 'object') {
      return { success: true, allFlipped: false, historyCurrentCards: null };
    }

    const cardIds = normalizeBookmarkIdList(Array.isArray(current.cardIds) ? current.cardIds : []);
    if (cardIds.length === 0 || !cardIds.includes(id)) {
      return {
        success: true,
        allFlipped: false,
        historyCurrentCards: {
          ...current,
          cardIds,
          flippedIds: normalizeBookmarkIdList(Array.isArray(current.flippedIds) ? current.flippedIds : [])
        }
      };
    }

    const flippedIds = normalizeBookmarkIdList(Array.isArray(current.flippedIds) ? current.flippedIds : []);
    if (!flippedIds.includes(id)) {
      flippedIds.push(id);
    }

    const next = {
      ...current,
      cardIds,
      flippedIds,
      timestamp: Date.now()
    };
    await browserAPI.storage.local.set({ [HISTORY_CURRENT_CARDS_STORAGE_KEY]: next });

    const allFlipped = cardIds.length > 0 && cardIds.every(cardId => flippedIds.includes(cardId));
    return { success: true, allFlipped, historyCurrentCards: next };
  });
}

function normalizeRecommendPoolLength(poolLength) {
  const value = Number(poolLength);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeRecommendPoolCursorValue(cursor, poolLength = 0) {
  const raw = Number(cursor);
  const safeRaw = Number.isFinite(raw) ? Math.floor(raw) : 0;
  const safePoolLength = normalizeRecommendPoolLength(poolLength);

  if (safePoolLength <= 0) {
    return Math.max(0, safeRaw);
  }

  return ((safeRaw % safePoolLength) + safePoolLength) % safePoolLength;
}

async function consumeRecommendPoolCursorState(poolLength, consumeCount = 0) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const safePoolLength = normalizeRecommendPoolLength(poolLength);
    const safeConsumeCount = Math.max(0, Math.floor(Number(consumeCount) || 0));

    if (safePoolLength <= 0) {
      await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: 0 });
      return {
        success: true,
        poolLength: 0,
        consumeCount: safeConsumeCount,
        cursorBefore: 0,
        cursorAfter: 0
      };
    }

    const result = await browserAPI.storage.local.get([RECOMMEND_POOL_CURSOR_STORAGE_KEY]);
    const currentCursor = normalizeRecommendPoolCursorValue(result?.[RECOMMEND_POOL_CURSOR_STORAGE_KEY], safePoolLength);
    const nextCursor = (currentCursor + safeConsumeCount) % safePoolLength;

    await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: nextCursor });

    return {
      success: true,
      poolLength: safePoolLength,
      consumeCount: safeConsumeCount,
      cursorBefore: currentCursor,
      cursorAfter: nextCursor
    };
  });
}

async function setRecommendPoolCursorState(poolLength, cursor = 0) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const safePoolLength = normalizeRecommendPoolLength(poolLength);
    const normalizedCursor = normalizeRecommendPoolCursorValue(cursor, safePoolLength);

    await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: normalizedCursor });

    return {
      success: true,
      poolLength: safePoolLength,
      cursor: normalizedCursor
    };
  });
}

function getLocalDateKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeHeatmapBookmarkCounts(counts = {}) {
  const source = counts && typeof counts === 'object' ? counts : {};
  const normalized = {};

  Object.entries(source).forEach(([bookmarkId, count]) => {
    const id = String(bookmarkId || '').trim();
    const value = Number(count);
    if (!id || !Number.isFinite(value) || value <= 0) return;
    normalized[id] = Math.max(1, Math.floor(value));
  });

  return normalized;
}

function normalizeHeatmapDayRecords(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      const timestamp = Number(item?.timestamp || 0);
      if (!bookmarkId || !Number.isFinite(timestamp) || timestamp <= 0) {
        return null;
      }
      return { bookmarkId, timestamp };
    })
    .filter(Boolean)
    .slice(-FLIP_HISTORY_DAY_RECORDS_MAX);
}

function normalizeHeatmapDayEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const records = normalizeHeatmapDayRecords(source.records || []);
  const byBookmark = normalizeHeatmapBookmarkCounts(source.byBookmark || {});

  if (Object.keys(byBookmark).length === 0 && records.length > 0) {
    records.forEach((record) => {
      byBookmark[record.bookmarkId] = (byBookmark[record.bookmarkId] || 0) + 1;
    });
  }

  const rawCount = Number(source.count);
  const count = Number.isFinite(rawCount) && rawCount >= records.length
    ? Math.floor(rawCount)
    : records.length;

  return {
    count: Math.max(0, count),
    byBookmark,
    records
  };
}

function normalizeHeatmapDailyIndex(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sourceDays = source.days && typeof source.days === 'object' ? source.days : {};
  const days = {};

  Object.entries(sourceDays).forEach(([dateKey, value]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    days[dateKey] = normalizeHeatmapDayEntry(value);
  });

  return {
    version: 1,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
    days
  };
}

function pruneHeatmapDailyIndex(index) {
  if (!index || typeof index !== 'object' || !index.days || typeof index.days !== 'object') return index;

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - FLIP_HISTORY_RETENTION_DAYS);
  const cutoffKey = getLocalDateKey(cutoff);

  Object.keys(index.days).forEach((dateKey) => {
    if (dateKey < cutoffKey) {
      delete index.days[dateKey];
    }
  });

  return index;
}

function appendFlipEventToHeatmapIndex(index, event) {
  const normalized = normalizeHeatmapDailyIndex(index);
  const bookmarkId = String(event?.bookmarkId || '').trim();
  const timestamp = Number(event?.timestamp || 0);

  if (!bookmarkId || !Number.isFinite(timestamp) || timestamp <= 0) {
    return normalized;
  }

  const dateKey = getLocalDateKey(new Date(timestamp));
  const day = normalizeHeatmapDayEntry(normalized.days[dateKey]);

  day.count += 1;
  day.byBookmark[bookmarkId] = (day.byBookmark[bookmarkId] || 0) + 1;

  day.records.push({ bookmarkId, timestamp });
  if (day.records.length > FLIP_HISTORY_DAY_RECORDS_MAX) {
    day.records = day.records.slice(day.records.length - FLIP_HISTORY_DAY_RECORDS_MAX);
  }

  normalized.days[dateKey] = day;
  normalized.updatedAt = Date.now();

  return pruneHeatmapDailyIndex(normalized);
}

function normalizeFlipHistoryRecords(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      const timestamp = Number(item?.timestamp || 0);
      if (!bookmarkId || !Number.isFinite(timestamp) || timestamp <= 0) {
        return null;
      }
      return { bookmarkId, timestamp: Math.floor(timestamp) };
    })
    .filter(Boolean)
    .slice(-FLIP_HISTORY_MAX_ITEMS);
}

async function appendRecommendFlipHistoryRecordState(bookmarkId, timestamp = Date.now()) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, count: -1 };
  }

  const safeTimestamp = Number.isFinite(Number(timestamp)) && Number(timestamp) > 0
    ? Math.floor(Number(timestamp))
    : Date.now();

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const result = await browserAPI.storage.local.get([FLIP_HISTORY_STORAGE_KEY, HEATMAP_DAILY_INDEX_STORAGE_KEY]);
    const flipHistory = normalizeFlipHistoryRecords(result?.[FLIP_HISTORY_STORAGE_KEY]);

    flipHistory.push({
      bookmarkId: id,
      timestamp: safeTimestamp
    });

    const trimmed = flipHistory.length > FLIP_HISTORY_MAX_ITEMS
      ? flipHistory.slice(flipHistory.length - FLIP_HISTORY_MAX_ITEMS)
      : flipHistory;

    const nextIndex = appendFlipEventToHeatmapIndex(
      result?.[HEATMAP_DAILY_INDEX_STORAGE_KEY],
      { bookmarkId: id, timestamp: safeTimestamp }
    );

    await browserAPI.storage.local.set({
      [FLIP_HISTORY_STORAGE_KEY]: trimmed,
      [HEATMAP_DAILY_INDEX_STORAGE_KEY]: nextIndex
    });

    return {
      success: true,
      count: trimmed.length,
      indexUpdatedAt: Number(nextIndex?.updatedAt || 0)
    };
  });
}

function normalizeRecommendReviewState(reviews) {
  if (!reviews || typeof reviews !== 'object') return {};
  return { ...reviews };
}

async function recordRecommendReviewState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, review: null, postponed: [], skippedIds: [] };
  }

  const state = await runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const [reviewResult, rawPostponed, rawSkipped] = await Promise.all([
      browserAPI.storage.local.get(['recommend_reviews']),
      getRecommendPostponedList(),
      getRecommendSkippedIds()
    ]);

    const reviews = normalizeRecommendReviewState(reviewResult?.recommend_reviews);
    const postponed = normalizeRecommendPostponedList(rawPostponed);
    const skippedIds = normalizeRecommendSkippedIds(rawSkipped);
    const now = Date.now();

    const nextPostponed = postponed.filter((item) => String(item?.bookmarkId || '').trim() !== id);
    const nextSkippedIds = normalizeRecommendSkippedIds(skippedIds.filter((item) => item !== id));

    const existing = reviews[id] && typeof reviews[id] === 'object' ? reviews[id] : null;
    const existingInterval = Number(existing?.interval);
    const baseInterval = Number.isFinite(existingInterval) && existingInterval > 0
      ? Math.floor(existingInterval)
      : 1;
    const existingReviewCount = Number(existing?.reviewCount);
    const baseReviewCount = Number.isFinite(existingReviewCount) && existingReviewCount > 0
      ? Math.floor(existingReviewCount)
      : 0;

    const nextInterval = existing ? Math.min(baseInterval * 2, 30) : 1;
    const nextReview = {
      lastReview: now,
      interval: nextInterval,
      reviewCount: baseReviewCount + 1,
      nextReview: now + nextInterval * 24 * 60 * 60 * 1000
    };

    reviews[id] = nextReview;

    await browserAPI.storage.local.set({
      recommend_reviews: reviews,
      [RECOMMEND_POSTPONED_STORAGE_KEY]: nextPostponed,
      [RECOMMEND_SKIPPED_STORAGE_KEY]: nextSkippedIds
    });

    return {
      success: true,
      review: nextReview,
      postponed: nextPostponed,
      skippedIds: nextSkippedIds
    };
  });

  await updateSingleBookmarkScore(id);

  return state;
}

function collectRemovedNodeIds(node, bookmarkIdSet, folderIdSet) {
  if (!node || typeof node !== 'object') return;

  const nodeId = String(node.id || '').trim();
  if (node.url) {
    if (nodeId) bookmarkIdSet.add(nodeId);
  } else {
    if (nodeId) folderIdSet.add(nodeId);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        collectRemovedNodeIds(child, bookmarkIdSet, folderIdSet);
      }
    }
  }
}

function queueRemovedRecommendStatePrune({ bookmarkIds = [], folderIds = [] } = {}) {
  const normalizedBookmarks = normalizeBookmarkIdList(bookmarkIds);
  const normalizedFolders = normalizeBookmarkIdList(folderIds);

  normalizedBookmarks.forEach((id) => pendingRemovedBookmarkIds.add(id));
  normalizedFolders.forEach((id) => pendingRemovedFolderIds.add(id));

  if (pendingRemovedBookmarkIds.size === 0 && pendingRemovedFolderIds.size === 0) {
    return;
  }

  if (removedRecommendPruneTimer) {
    clearTimeout(removedRecommendPruneTimer);
  }

  removedRecommendPruneTimer = setTimeout(() => {
    removedRecommendPruneTimer = null;
    runRemovedRecommendStatePrune().catch((e) => {
      console.warn('[Recommend] prune removed state failed:', e);
    });
  }, REMOVED_RECOMMEND_PRUNE_DEBOUNCE_MS);
}

async function runRemovedRecommendStatePrune() {
  const removedBookmarkIds = normalizeBookmarkIdList(Array.from(pendingRemovedBookmarkIds));
  const removedFolderIds = normalizeBookmarkIdList(Array.from(pendingRemovedFolderIds));
  pendingRemovedBookmarkIds.clear();
  pendingRemovedFolderIds.clear();

  if (removedBookmarkIds.length === 0 && removedFolderIds.length === 0) {
    return;
  }

  const removedBookmarkSet = new Set(removedBookmarkIds);
  const removedFolderSet = new Set(removedFolderIds);

  await runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const [rawSkipped, rawPostponed, rawBlocked, rawCache, historyCardsResult] = await Promise.all([
      getRecommendSkippedIds(),
      getRecommendPostponedList(),
      getRecommendBlockedState(),
      getScoresCache(),
      browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY])
    ]);

    const updates = {};

    const nextSkipped = normalizeRecommendSkippedIds(
      rawSkipped.filter(id => !removedBookmarkSet.has(String(id || '').trim()))
    );
    if (nextSkipped.length !== rawSkipped.length) {
      updates[RECOMMEND_SKIPPED_STORAGE_KEY] = nextSkipped;
    }

    const normalizedPostponed = normalizeRecommendPostponedList(rawPostponed || []);
    const nextPostponed = normalizedPostponed.filter((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      return bookmarkId && !removedBookmarkSet.has(bookmarkId);
    });
    if (nextPostponed.length !== normalizedPostponed.length) {
      updates[RECOMMEND_POSTPONED_STORAGE_KEY] = nextPostponed;
    }

    const blocked = normalizeRecommendBlockedState(rawBlocked);
    const nextBlocked = {
      bookmarks: blocked.bookmarks.filter(id => !removedBookmarkSet.has(String(id || '').trim())),
      folders: blocked.folders.filter(id => !removedFolderSet.has(String(id || '').trim())),
      domains: blocked.domains.slice()
    };

    if (
      nextBlocked.bookmarks.length !== blocked.bookmarks.length
      || nextBlocked.folders.length !== blocked.folders.length
    ) {
      updates[RECOMMEND_BLOCKED_STORAGE_KEY] = nextBlocked;
    }

    const cache = rawCache && typeof rawCache === 'object' ? { ...rawCache } : {};
    let cacheChanged = false;
    for (const bookmarkId of removedBookmarkSet) {
      if (Object.prototype.hasOwnProperty.call(cache, bookmarkId)) {
        delete cache[bookmarkId];
        cacheChanged = true;
      }
    }
    if (cacheChanged) {
      updates.recommend_scores_cache = cache;
      updates.recommend_scores_time = Date.now();
    }

    const historyCurrentCards = historyCardsResult?.[HISTORY_CURRENT_CARDS_STORAGE_KEY];
    if (historyCurrentCards && typeof historyCurrentCards === 'object') {
      const cardIds = Array.isArray(historyCurrentCards.cardIds)
        ? historyCurrentCards.cardIds.map(id => String(id || '').trim()).filter(Boolean)
        : [];
      const flippedIds = Array.isArray(historyCurrentCards.flippedIds)
        ? historyCurrentCards.flippedIds.map(id => String(id || '').trim()).filter(Boolean)
        : [];
      const cardData = Array.isArray(historyCurrentCards.cardData)
        ? historyCurrentCards.cardData.filter(item => !removedBookmarkSet.has(String(item?.id || '').trim()))
        : undefined;

      const nextCardIds = cardIds.filter(id => !removedBookmarkSet.has(id));
      const nextFlippedIds = flippedIds.filter(id => !removedBookmarkSet.has(id));

      if (
        nextCardIds.length !== cardIds.length
        || nextFlippedIds.length !== flippedIds.length
        || (Array.isArray(cardData) && cardData.length !== (Array.isArray(historyCurrentCards.cardData) ? historyCurrentCards.cardData.length : 0))
      ) {
        updates[HISTORY_CURRENT_CARDS_STORAGE_KEY] = {
          ...historyCurrentCards,
          cardIds: nextCardIds,
          flippedIds: nextFlippedIds,
          ...(Array.isArray(cardData) ? { cardData } : {}),
          timestamp: Date.now()
        };
      }
    }

    if (Object.keys(updates).length > 0) {
      await browserAPI.storage.local.set(updates);
    }
  });
}

async function scheduleBulkTemplateRecovery(reason = '') {
  if (bulkTemplateRecoveryTimer) {
    clearTimeout(bulkTemplateRecoveryTimer);
  }

  bulkTemplateRecoveryTimer = setTimeout(async () => {
    bulkTemplateRecoveryTimer = null;

    if (isBookmarkImporting || isBookmarkBulkChanging) {
      scheduleBulkTemplateRecovery(reason);
      return;
    }

    if (isComputingScores) {
      scheduleBulkTemplateRecovery(reason);
      return;
    }

    try {
      const ids = await getAllBookmarkUrlIdsForScore();
      if (!Array.isArray(ids) || ids.length === 0) {
        await browserAPI.storage.local.set({
          recommendScoresStaleMeta: { staleAt: 0, reason: `bulk-template:${reason || 'none'}:empty` }
        });
        return;
      }

      if (ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD) {
        await applyTemplateScoresByIds(ids);
        queueTemplateScoreRefine(ids);
      } else {
        await updateBookmarkScoresByIds(ids);
      }

      await browserAPI.storage.local.set({
        recommendScoresStaleMeta: { staleAt: 0, reason: `bulk-template:${reason || 'none'}` }
      });
    } catch (e) {
      console.warn('[S-score] bulk template recovery failed:', e);
    }
  }, BULK_TEMPLATE_RECOVERY_DEBOUNCE_MS);
}

async function ensureRecommendScoresReady(options = {}) {
  if (recommendScoresReadyPromise) {
    return recommendScoresReadyPromise;
  }

  const reason = String(options?.reason || 'unknown');

  recommendScoresReadyPromise = (async () => {
    try {
      const existingCache = await getScoresCache();
      const existingCount = Object.keys(existingCache || {}).length;
      if (existingCount > 0) {
        return {
          success: true,
          ready: true,
          mode: 'existing',
          cacheCount: existingCount
        };
      }

      if (isBookmarkImporting || isBookmarkBulkChanging) {
        return {
          success: true,
          ready: false,
          mode: 'bulk-pending',
          cacheCount: existingCount
        };
      }

      if (isComputingScores || templateRefineRunning) {
        return {
          success: true,
          ready: false,
          mode: 'computing',
          cacheCount: existingCount
        };
      }

      const ids = await getAllBookmarkUrlIdsForScore();
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          success: true,
          ready: true,
          mode: 'empty-tree',
          cacheCount: 0,
          bookmarkCount: 0
        };
      }

      if (ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD) {
        await applyTemplateScoresByIds(ids);
        queueTemplateScoreRefine(ids);
      } else {
        await updateBookmarkScoresByIds(ids);
      }

      const nextCache = await getScoresCache();
      const nextCount = Object.keys(nextCache || {}).length;

      try {
        await browserAPI.storage.local.set({
          recommendScoresStaleMeta: {
            staleAt: 0,
            reason: `ensure-ready:${reason}`
          }
        });
      } catch (_) { }

      return {
        success: true,
        ready: nextCount > 0,
        mode: ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD ? 'template' : 'incremental',
        cacheCount: nextCount,
        bookmarkCount: ids.length
      };
    } catch (e) {
      console.warn('[S-score] ensure-ready failed:', e);
      return {
        success: false,
        ready: false,
        error: e?.message || String(e)
      };
    }
  })();

  recommendScoresReadyPromise.finally(() => {
    if (recommendScoresReadyPromise) {
      recommendScoresReadyPromise = null;
    }
  });

  return recommendScoresReadyPromise;
}

function scheduleBookmarkBulkExit() {
  if (bookmarkBulkExitTimer) {
    clearTimeout(bookmarkBulkExitTimer);
  }
  bookmarkBulkExitTimer = setTimeout(() => {
    bookmarkBulkExitTimer = null;
    exitBookmarkBulkChangeMode().catch(() => { });
  }, BOOKMARK_BULK_QUIET_MS);
}

function scheduleRecomputeAllScoresSoon(reason = '', options = {}) {
  const forceFull = options && options.forceFull === true;
  if (scheduledRecomputeTimer) clearTimeout(scheduledRecomputeTimer);
  scheduledRecomputeTimer = setTimeout(() => {
    scheduledRecomputeTimer = null;
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    computeAllBookmarkScores({ forceFull })
      .then(() => {
        try {
          browserAPI.storage.local.set({
            recommendScoresStaleMeta: { staleAt: 0, reason: reason || '' }
          });
        } catch (_) { }
      })
      .catch(() => { });
  }, 800);
}

async function getScoreCacheMode() {
  if (scoreCacheMode === SCORE_CACHE_MODE_FULL || scoreCacheMode === SCORE_CACHE_MODE_COMPACT) {
    return scoreCacheMode;
  }
  try {
    const result = await browserAPI.storage.local.get([SCORE_CACHE_MODE_KEY]);
    const mode = result?.[SCORE_CACHE_MODE_KEY];
    scoreCacheMode = mode === SCORE_CACHE_MODE_FULL ? SCORE_CACHE_MODE_FULL : SCORE_CACHE_MODE_COMPACT;
    return scoreCacheMode;
  } catch (_) {
    scoreCacheMode = SCORE_CACHE_MODE_COMPACT;
    return scoreCacheMode;
  }
}

async function enterBookmarkBulkChangeMode(reason = '') {
  if (isBookmarkBulkChanging) {
    scheduleBookmarkBulkExit();
    return;
  }

  isBookmarkBulkChanging = true;
  lastBulkReason = reason || 'unknown';
  bookmarkBulkHasRemoval = reason === 'removed';
  try { await browserAPI.storage.local.set({ bookmarkBulkChangeFlag: true }); } catch (_) { }
  await invalidateRecommendCaches(`bulk:${reason || 'unknown'}`);
  clearBookmarkUrlIndex();
  scheduleBookmarkBulkExit();
}

async function exitBookmarkBulkChangeMode() {
  if (!isBookmarkBulkChanging) return;

  isBookmarkBulkChanging = false;
  bookmarkBulkWindowStart = 0;
  bookmarkBulkEventCount = 0;
  try { await browserAPI.storage.local.set({ bookmarkBulkChangeFlag: false }); } catch (_) { }

  // 导入场景：不要自动全量重算，避免导入结束“立刻重算”再次拉跨浏览器；交给 UI 按需触发。
  const reason = String(lastBulkReason || '');
  if (!reason.startsWith('import')) {
    await scheduleBulkTemplateRecovery(`bulk-exit:${reason || 'unknown'}`);
  }
  bookmarkBulkHasRemoval = false;
}

function noteBookmarkEventForBulkGuard(eventType = '') {
  // 导入本身有独立 flag：不需要通过计数进入 bulk
  // 重要：导入期间事件极多，频繁 clearTimeout/setTimeout 也会带来额外卡顿
  if (isBookmarkImporting) {
    return;
  }

  if (eventType === 'removed') {
    bookmarkBulkHasRemoval = true;
  }

  const now = Date.now();
  if (!bookmarkBulkWindowStart || now - bookmarkBulkWindowStart > BOOKMARK_BULK_WINDOW_MS) {
    bookmarkBulkWindowStart = now;
    bookmarkBulkEventCount = 0;
  }

  bookmarkBulkEventCount += 1;

  if (!isBookmarkBulkChanging && bookmarkBulkEventCount >= BOOKMARK_BULK_THRESHOLD) {
    enterBookmarkBulkChangeMode(eventType || 'events').catch(() => { });
    return;
  }

  if (isBookmarkBulkChanging) {
    scheduleBookmarkBulkExit();
  }
}

function pickBootstrapBookmarks(bookmarks, limit) {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) return [];
  const maxCount = Number.isFinite(limit) ? Math.max(1, limit) : SCORE_BOOTSTRAP_LIMIT;
  const list = bookmarks.slice();
  list.sort((a, b) => {
    const diff = (b?.dateAdded || 0) - (a?.dateAdded || 0);
    if (diff !== 0) return diff;
    const aTitle = String(a?.title || a?.name || '').toLowerCase();
    const bTitle = String(b?.title || b?.name || '').toLowerCase();
    if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  return list.slice(0, maxCount);
}

async function getFormulaConfig() {
  const DEFAULT_CONFIG = {
    weights: { freshness: 0.15, coldness: 0.15, shallowRead: 0.30, forgetting: 0.20, laterReview: 0.20 },
    thresholds: { freshness: 30, coldness: 10, shallowRead: 5, forgetting: 14 }
  };

  const result = await browserAPI.storage.local.get(['recommendFormulaConfig', 'trackingEnabled']);
  const stored = result.recommendFormulaConfig || null;
  const config = {
    ...DEFAULT_CONFIG,
    ...(stored || {}),
    weights: {
      ...DEFAULT_CONFIG.weights,
      ...((stored && stored.weights) ? stored.weights : {})
    },
    thresholds: {
      ...DEFAULT_CONFIG.thresholds,
      ...((stored && stored.thresholds) ? stored.thresholds : {})
    }
  };

  if (!stored) {
    try {
      await browserAPI.storage.local.set({ recommendFormulaConfig: config });
    } catch (_) { }
    // 之前可能已经按旧默认值计算过缓存：确保公式默认值与 UI 一致后，清空旧缓存避免“显示公式”和“实际分数”不一致。
    await invalidateRecommendCaches('init-default-formula');
  }

  config.trackingEnabled = result.trackingEnabled !== false;
  return config;
}

function normalizeBlockedDomain(domain) {
  if (!domain) return '';
  return String(domain).toLowerCase().replace(/^www\./, '');
}

function normalizeScoreUrlKey(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return String(url);
    u.hash = '';
    let pathname = u.pathname || '';
    if (pathname === '/') pathname = '';
    return `${u.origin}${pathname}${u.search || ''}`;
  } catch (_) {
    return String(url);
  }
}

let bookmarkUrlIndexReady = false;
let bookmarkUrlIndexBuilding = null;
let bookmarkUrlIndexStale = false;
const bookmarkUrlIndex = new Map(); // urlKey -> Set<bookmarkId>
const bookmarkIdToUrlKey = new Map();

function clearBookmarkUrlIndex() {
  bookmarkUrlIndex.clear();
  bookmarkIdToUrlKey.clear();
  bookmarkUrlIndexReady = false;
  bookmarkUrlIndexStale = true;
}

function addBookmarkToUrlIndex(bookmark) {
  if (!bookmark || !bookmark.id || !bookmark.url) return;
  const key = normalizeScoreUrlKey(bookmark.url);
  if (!key) return;
  let set = bookmarkUrlIndex.get(key);
  if (!set) {
    set = new Set();
    bookmarkUrlIndex.set(key, set);
  }
  set.add(bookmark.id);
  bookmarkIdToUrlKey.set(bookmark.id, key);
}

function removeBookmarkFromUrlIndex(bookmarkId) {
  if (!bookmarkId) return;
  const key = bookmarkIdToUrlKey.get(bookmarkId);
  if (!key) return;
  const set = bookmarkUrlIndex.get(key);
  if (set) {
    set.delete(bookmarkId);
    if (set.size === 0) {
      bookmarkUrlIndex.delete(key);
    }
  }
  bookmarkIdToUrlKey.delete(bookmarkId);
}

function updateBookmarkUrlIndex(bookmarkId, newUrl) {
  removeBookmarkFromUrlIndex(bookmarkId);
  if (!newUrl) return;
  const key = normalizeScoreUrlKey(newUrl);
  if (!key) return;
  let set = bookmarkUrlIndex.get(key);
  if (!set) {
    set = new Set();
    bookmarkUrlIndex.set(key, set);
  }
  set.add(bookmarkId);
  bookmarkIdToUrlKey.set(bookmarkId, key);
}

async function buildBookmarkUrlIndex() {
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  const nextIndex = new Map();
  const nextIdMap = new Map();

  function traverse(nodes) {
    for (const node of nodes) {
      if (node.url) {
        const key = normalizeScoreUrlKey(node.url);
        if (key) {
          let set = nextIndex.get(key);
          if (!set) {
            set = new Set();
            nextIndex.set(key, set);
          }
          set.add(node.id);
          nextIdMap.set(node.id, key);
        }
      }
      if (node.children) traverse(node.children);
    }
  }

  traverse(tree);

  bookmarkUrlIndex.clear();
  bookmarkIdToUrlKey.clear();
  for (const [key, set] of nextIndex.entries()) {
    bookmarkUrlIndex.set(key, set);
  }
  for (const [id, key] of nextIdMap.entries()) {
    bookmarkIdToUrlKey.set(id, key);
  }
  bookmarkUrlIndexReady = true;
  bookmarkUrlIndexStale = false;
}

async function ensureBookmarkUrlIndex() {
  if (bookmarkUrlIndexReady && !bookmarkUrlIndexStale) return true;
  if (bookmarkUrlIndexBuilding) return bookmarkUrlIndexBuilding;
  if (isBookmarkImporting || isBookmarkBulkChanging) return false;
  bookmarkUrlIndexBuilding = buildBookmarkUrlIndex()
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      bookmarkUrlIndexBuilding = null;
    });
  return bookmarkUrlIndexBuilding;
}

async function getBlockedDataForScore() {
  const result = await browserAPI.storage.local.get(['recommend_blocked']);
  const blocked = result.recommend_blocked || { bookmarks: [], folders: [], domains: [] };
  return {
    bookmarks: new Set(blocked.bookmarks || []),
    domains: new Set((blocked.domains || []).map(normalizeBlockedDomain).filter(Boolean)),
    folders: new Set(blocked.folders || [])
  };
}

async function getScoresCache() {
  const result = await browserAPI.storage.local.get(['recommend_scores_cache']);
  return result.recommend_scores_cache || {};
}

async function saveScoresCache(cache) {
  try {
    await browserAPI.storage.local.set({ recommend_scores_cache: cache, recommend_scores_time: Date.now() });
  } catch (error) {
    if (error.message && error.message.includes('QUOTA')) {
      console.warn('[S-score] storage quota reached, cleaning...');
      try {
        const keysToCheck = [FLIPPED_BOOKMARKS_STORAGE_KEY, 'thumbnailCache', RECOMMEND_POSTPONED_STORAGE_KEY];
        const data = await browserAPI.storage.local.get(keysToCheck);

        if (data[FLIPPED_BOOKMARKS_STORAGE_KEY]) {
          const raw = data[FLIPPED_BOOKMARKS_STORAGE_KEY];
          let normalized = [];

          if (Array.isArray(raw)) {
            normalized = raw
              .map(id => String(id || '').trim())
              .filter(Boolean);
          } else if (raw && typeof raw === 'object') {
            const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            normalized = Object.entries(raw)
              .filter(([, time]) => Number(time) > oneWeekAgo)
              .sort((a, b) => Number(a[1]) - Number(b[1]))
              .map(([id]) => String(id || '').trim())
              .filter(Boolean);
          }

          if (normalized.length > 1000) {
            normalized = normalized.slice(normalized.length - 1000);
          }

          await browserAPI.storage.local.set({ [FLIPPED_BOOKMARKS_STORAGE_KEY]: normalized });
        }

        if (data.thumbnailCache) {
          await browserAPI.storage.local.remove(['thumbnailCache']);
        }

        await browserAPI.storage.local.set({ recommend_scores_cache: cache, recommend_scores_time: Date.now() });
      } catch (retryError) {
        console.error('[S-score] save after cleanup failed:', retryError);
      }
    } else {
      console.error('[S-score] save failed:', error);
    }
  }
}

async function getPostponedBookmarksForScore() {
  const result = await browserAPI.storage.local.get(['recommend_postponed']);
  return result.recommend_postponed || [];
}

async function getReviewDataForScore() {
  const result = await browserAPI.storage.local.get(['recommend_reviews']);
  return result.recommend_reviews || {};
}

async function getTrackingDataForScore() {
  try {
    const stats = await getTrackingStats();
    const byUrl = new Map();
    const byTitle = new Map();
    const byBookmarkId = new Map();
    let totalMs = 0;
    let totalCount = 0;

    for (const [key, stat] of Object.entries(stats)) {
      const data = {
        url: stat.url,
        title: stat.title || key,
        compositeMs: stat.totalCompositeMs || 0,
        bookmarkId: stat.bookmarkId || null
      };
      totalMs += data.compositeMs || 0;
      totalCount += 1;
      if (stat.url) {
        const urlKey = normalizeScoreUrlKey(stat.url);
        if (urlKey) byUrl.set(urlKey, data);
      }
      if (stat.title) byTitle.set(stat.title, data);
      if (stat.bookmarkId) byBookmarkId.set(stat.bookmarkId, data);
    }

    return { byUrl, byTitle, byBookmarkId, totalMs, totalCount };
  } catch (e) {
    console.warn('[S-score] tracking stats failed:', e);
    return { byUrl: new Map(), byTitle: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
  }
}

function calculateFactorValue(value, threshold, inverse = false) {
  if (value <= 0) return inverse ? 1 : 0;
  const safeThreshold = Math.max(1, threshold || 1);
  const decayed = 1 / (1 + Math.pow(value / safeThreshold, 0.7));
  return inverse ? decayed : (1 - decayed);
}

function resolveHistoryForScore(bookmark, historyStats) {
  const empty = { visitCount: 0, lastVisitTime: 0 };
  const result = {
    matchType: 'none',
    matchKey: null,
    history: empty
  };

  if (!historyStats || !bookmark?.url) return result;

  const urlKey = normalizeScoreUrlKey(bookmark.url);
  if (!urlKey) return result;

  let history = historyStats.get(urlKey);
  if (history && history.visitCount > 0) {
    return { matchType: 'url', matchKey: urlKey, history };
  }

  if (bookmark.title && historyStats.titleMap) {
    history = historyStats.titleMap.get(bookmark.title);
    if (history && history.visitCount > 0) {
      return { matchType: 'title', matchKey: bookmark.title, history };
    }
  }

  try {
    if (bookmark.url && historyStats.domainMap) {
      const domain = normalizeBlockedDomain(new URL(bookmark.url).hostname);
      history = historyStats.domainMap.get(domain);
      if (history && history.visitCount > 0) {
        return { matchType: 'domain', matchKey: domain, history };
      }
    }
  } catch (_) { }

  return result;
}

function resolveTrackingForScore(bookmark, trackingData) {
  const result = {
    matchType: 'none',
    matchKey: null,
    compositeMs: 0,
    ignoredTitleHit: false
  };

  if (!trackingData || !bookmark) return result;

  if (bookmark.id && trackingData.byBookmarkId && trackingData.byBookmarkId.has(bookmark.id)) {
    const hit = trackingData.byBookmarkId.get(bookmark.id);
    return { matchType: 'bookmarkId', matchKey: bookmark.id, compositeMs: hit?.compositeMs || 0, ignoredTitleHit: false };
  }

  if (bookmark.url && trackingData.byUrl) {
    const urlKey = normalizeScoreUrlKey(bookmark.url);
    if (urlKey && trackingData.byUrl.has(urlKey)) {
      const hit = trackingData.byUrl.get(urlKey);
      return { matchType: 'url', matchKey: urlKey, compositeMs: hit?.compositeMs || 0, ignoredTitleHit: false };
    }
  }

  if (bookmark.title && trackingData.byTitle && trackingData.byTitle.has(bookmark.title)) {
    const titleHit = trackingData.byTitle.get(bookmark.title);
    if (titleHit) {
      if (bookmark.id && titleHit.bookmarkId && titleHit.bookmarkId === bookmark.id) {
        return { matchType: 'title', matchKey: bookmark.title, compositeMs: titleHit.compositeMs || 0, ignoredTitleHit: false };
      }
      if (!bookmark.id && !titleHit.bookmarkId) {
        return { matchType: 'title', matchKey: bookmark.title, compositeMs: titleHit.compositeMs || 0, ignoredTitleHit: false };
      }
      result.ignoredTitleHit = true;
    }
  }

  return result;
}

function resolveLaterFactorForScore(bookmarkId, postponedList) {
  const result = { L: 0, postponeInfo: null };
  if (!bookmarkId || !Array.isArray(postponedList) || postponedList.length === 0) return result;
  const postponeInfo = postponedList.find(p => p.bookmarkId === bookmarkId) || null;
  if (postponeInfo && postponeInfo.manuallyAdded) {
    return { L: 1, postponeInfo };
  }
  return { L: 0, postponeInfo };
}

function resolveReviewFactorForScore(bookmarkId, reviewData, now) {
  const result = {
    R: 1,
    review: null,
    daysSinceReview: null,
    stability: null,
    needReview: null
  };
  if (!bookmarkId || !reviewData) return result;
  const review = reviewData[bookmarkId];
  if (!review) return result;

  const safeNow = typeof now === 'number' ? now : Date.now();
  const daysSinceReview = (safeNow - review.lastReview) / (1000 * 60 * 60 * 24);
  const reviewCount = review.reviewCount || 1;
  const stabilityTable = [3, 7, 14, 30, 60];
  const stability = stabilityTable[Math.min(reviewCount - 1, stabilityTable.length - 1)];
  const needReview = 1 - Math.pow(0.9, daysSinceReview / stability);
  let R = 0.7 + 0.3 * needReview;
  R = Math.max(0.7, Math.min(1, R));
  return { R, review, daysSinceReview, stability, needReview };
}

function calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData) {
  const now = Date.now();
  const thresholds = config.thresholds;

  const historyResult = resolveHistoryForScore(bookmark, historyStats);
  const history = historyResult.history || { visitCount: 0, lastVisitTime: 0 };

  const trackingResult = resolveTrackingForScore(bookmark, trackingData);
  const compositeMs = trackingResult.compositeMs || 0;

  const daysSinceAdded = (now - (bookmark.dateAdded || now)) / (1000 * 60 * 60 * 24);
  const F = calculateFactorValue(daysSinceAdded, thresholds.freshness, true);

  const C = calculateFactorValue(history.visitCount, thresholds.coldness, true);

  const compositeMinutes = compositeMs / (1000 * 60);
  const trackingWarm = (trackingData?.totalMs || 0) >= TRACKING_WARMUP_MIN_MS
    || (trackingData?.totalCount || 0) >= TRACKING_WARMUP_MIN_COUNT;
  const trackingHit = trackingResult.matchType !== 'none';
  const T = trackingHit
    ? calculateFactorValue(compositeMinutes, thresholds.shallowRead, true)
    : TRACKING_NEUTRAL_T;

  let daysSinceLastVisit = thresholds.forgetting;
  if (history.lastVisitTime > 0) {
    daysSinceLastVisit = (now - history.lastVisitTime) / (1000 * 60 * 60 * 24);
  } else {
    // 从未访问过：用“加入时间”作为 proxy，避免 D 永远固定在阈值处（0.5）导致分数扎堆。
    daysSinceLastVisit = Math.max(daysSinceAdded, thresholds.forgetting);
  }
  const D = calculateFactorValue(daysSinceLastVisit, thresholds.forgetting, false);

  const laterResult = resolveLaterFactorForScore(bookmark.id, postponedList);
  const L = laterResult.L;

  const reviewResult = resolveReviewFactorForScore(bookmark.id, reviewData, now);
  const R = reviewResult.R;

  const weights = config.weights || {};
  let w1 = weights.freshness ?? 0.15;
  let w2 = weights.coldness ?? 0.15;
  let w3 = weights.shallowRead ?? 0.30;
  let w4 = weights.forgetting ?? 0.20;
  let w5 = weights.laterReview ?? 0.20;

  if (!config.trackingEnabled || !trackingWarm) {
    const remaining = w1 + w2 + w4 + w5;
    if (remaining > 0) {
      w1 = w1 / remaining;
      w2 = w2 / remaining;
      w4 = w4 / remaining;
      w5 = w5 / remaining;
    }
    w3 = 0;
  }

  const basePriority = w1 * F + w2 * C + w3 * T + w4 * D + w5 * L;
  const priority = basePriority * R;
  // 注意：S 值缓存必须可复现（不含随机项），否则每次重算都会抡动推荐结果/数值，用户会感知“闪”“漂”。
  const S = Math.max(0, Math.min(1, priority));

  return { S, F, C, T, D, L, R };
}

const SCORE_DEBUG_CONTEXT_TTL_MS = 60 * 1000;
let scoreDebugHistoryStatsCache = { loadedAt: 0, stats: null };

function invalidateScoreDebugHistoryStatsCache() {
  scoreDebugHistoryStatsCache = { loadedAt: 0, stats: null };
}

async function getHistoryStatsForScoreDebug() {
  try {
    const now = Date.now();
    if (scoreDebugHistoryStatsCache.stats && (now - (scoreDebugHistoryStatsCache.loadedAt || 0)) < SCORE_DEBUG_CONTEXT_TTL_MS) {
      return scoreDebugHistoryStatsCache.stats;
    }
    const stats = await getBatchHistoryDataWithTitle();
    scoreDebugHistoryStatsCache = { loadedAt: now, stats };
    return stats;
  } catch (_) {
    return new Map();
  }
}

function calculateBookmarkScoreDebug(bookmark, historyStats, trackingData, config, postponedList, reviewData) {
  const now = Date.now();
  const thresholds = config.thresholds;

  const historyResult = resolveHistoryForScore(bookmark, historyStats);
  const history = historyResult.history || { visitCount: 0, lastVisitTime: 0 };

  const trackingResult = resolveTrackingForScore(bookmark, trackingData);
  const compositeMs = trackingResult.compositeMs || 0;

  const daysSinceAdded = (now - (bookmark.dateAdded || now)) / (1000 * 60 * 60 * 24);
  const compositeMinutes = compositeMs / (1000 * 60);
  const trackingWarm = (trackingData?.totalMs || 0) >= TRACKING_WARMUP_MIN_MS
    || (trackingData?.totalCount || 0) >= TRACKING_WARMUP_MIN_COUNT;

  let daysSinceLastVisit = thresholds.forgetting;
  if (history.lastVisitTime > 0) {
    daysSinceLastVisit = (now - history.lastVisitTime) / (1000 * 60 * 60 * 24);
  } else {
    daysSinceLastVisit = Math.max(daysSinceAdded, thresholds.forgetting);
  }

  const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
  const laterResult = resolveLaterFactorForScore(bookmark.id, postponedList);
  const reviewResult = resolveReviewFactorForScore(bookmark.id, reviewData, now);

  const weights = config.weights || {};
  let w1 = weights.freshness ?? 0.15;
  let w2 = weights.coldness ?? 0.15;
  let w3 = weights.shallowRead ?? 0.30;
  let w4 = weights.forgetting ?? 0.20;
  let w5 = weights.laterReview ?? 0.20;
  if (!config.trackingEnabled || !trackingWarm) {
    const remaining = w1 + w2 + w4 + w5;
    if (remaining > 0) {
      w1 = w1 / remaining;
      w2 = w2 / remaining;
      w4 = w4 / remaining;
      w5 = w5 / remaining;
    }
    w3 = 0;
  }

  return {
    now,
    bookmark: {
      id: bookmark.id,
      title: bookmark.title || '',
      url: bookmark.url || '',
      dateAdded: bookmark.dateAdded || 0,
      parentId: bookmark.parentId || null
    },
    config: {
      thresholds: { ...thresholds },
      weights: { ...weights },
      trackingEnabled: !!config.trackingEnabled
    },
    weightsUsed: { w1, w2, w3, w4, w5 },
    matches: {
      history: {
        type: historyResult.matchType,
        key: historyResult.matchKey,
        visitCount: history.visitCount || 0,
        lastVisitTime: history.lastVisitTime || 0
      },
      tracking: {
        type: trackingResult.matchType,
        key: trackingResult.matchKey,
        compositeMs,
        ignoredTitleHit: !!trackingResult.ignoredTitleHit
      }
    },
    raw: {
      daysSinceAdded,
      compositeMinutes,
      daysSinceLastVisit,
      postponeInfo: laterResult.postponeInfo,
      review: reviewResult.review,
      daysSinceReview: reviewResult.daysSinceReview,
      stability: reviewResult.stability,
      needReview: reviewResult.needReview
    },
    factors: scores
  };
}

async function getBatchHistoryDataWithTitle() {
  const urlMap = new Map();
  const titleMap = new Map();
  const domainMap = new Map();

  if (!browserAPI.history) {
    const result = urlMap;
    result.titleMap = titleMap;
    result.domainMap = domainMap;
    return result;
  }

  try {
    // 尽量覆盖更多历史（maxResults 兜底），避免导入大量书签后“无历史”比例过高导致分数扎堆。
    const historyStartTime = 0;
    const historyItems = await new Promise(resolve => {
      browserAPI.history.search({
        text: '',
        startTime: historyStartTime,
        maxResults: 50000
      }, resolve);
    });

    for (const item of historyItems) {
      if (!item.url) continue;
      const urlKey = normalizeScoreUrlKey(item.url);
      if (!urlKey) continue;
      const data = {
        visitCount: item.visitCount || 0,
        lastVisitTime: item.lastVisitTime || 0
      };

      if (!urlMap.has(urlKey)) {
        urlMap.set(urlKey, data);
      } else {
        const existing = urlMap.get(urlKey);
        urlMap.set(urlKey, {
          visitCount: (existing.visitCount || 0) + data.visitCount,
          lastVisitTime: Math.max(existing.lastVisitTime || 0, data.lastVisitTime || 0)
        });
      }

      const title = item.title && item.title.trim();
      if (title) {
        if (!titleMap.has(title)) {
          titleMap.set(title, data);
        } else {
          const existing = titleMap.get(title);
          titleMap.set(title, {
            visitCount: existing.visitCount + data.visitCount,
            lastVisitTime: Math.max(existing.lastVisitTime, data.lastVisitTime)
          });
        }
      }

      try {
        const domain = normalizeBlockedDomain(new URL(item.url).hostname);
        if (domain) {
          if (!domainMap.has(domain)) {
            domainMap.set(domain, data);
          } else {
            const existing = domainMap.get(domain);
            domainMap.set(domain, {
              visitCount: existing.visitCount + data.visitCount,
              lastVisitTime: Math.max(existing.lastVisitTime, data.lastVisitTime)
            });
          }
        }
      } catch (_) { }
    }
  } catch (e) {
    console.warn('[S-score] batch history load failed:', e);
  }

  const result = urlMap;
  result.titleMap = titleMap;
  result.domainMap = domainMap;
  return result;
}

async function computeAllBookmarkScores(options = {}) {
  if (isComputingScores) {
    return false;
  }
  if (isBookmarkImporting) {
    return false;
  }
  isComputingScores = true;

  try {
    const forceFull = options && options.forceFull === true;
    const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
    const allBookmarks = [];
    function traverse(nodes, ancestors = []) {
      for (const node of nodes) {
        if (node.url) allBookmarks.push({ ...node, ancestorFolderIds: ancestors });
        if (node.children) {
          const nextAncestors = node.url ? ancestors : [...ancestors, node.id];
          traverse(node.children, nextAncestors);
        }
      }
    }
    traverse(tree, []);

    if (allBookmarks.length === 0) {
      isComputingScores = false;
      return true;
    }

    const [blocked, config, postponedList, reviewData] = await Promise.all([
      getBlockedDataForScore(),
      getFormulaConfig(),
      getPostponedBookmarksForScore(),
      getReviewDataForScore()
    ]);

    const isBlockedDomain = (bookmark) => {
      if (blocked.domains.size === 0 || !bookmark.url) return false;
      try {
        const url = new URL(bookmark.url);
        return blocked.domains.has(normalizeBlockedDomain(url.hostname));
      } catch {
        return false;
      }
    };

    const isInBlockedFolder = (bookmark) => {
      if (blocked.folders.size === 0) return false;
      if (bookmark.parentId && blocked.folders.has(bookmark.parentId)) return true;
      const ancestorFolderIds = bookmark.ancestorFolderIds || [];
      for (const folderId of ancestorFolderIds) {
        if (blocked.folders.has(folderId)) return true;
      }
      return false;
    };

    const availableBookmarks = allBookmarks.filter(b =>
      !blocked.bookmarks.has(b.id) &&
      !isInBlockedFolder(b) &&
      !isBlockedDomain(b)
    );

    const totalCount = availableBookmarks.length;
    const nextMode = totalCount > SCORE_CACHE_COMPACT_THRESHOLD ? SCORE_CACHE_MODE_COMPACT : SCORE_CACHE_MODE_FULL;
    scoreCacheMode = nextMode;
    try { await browserAPI.storage.local.set({ [SCORE_CACHE_MODE_KEY]: nextMode }); } catch (_) { }

    const existingCache = await getScoresCache();
    const existingCount = Object.keys(existingCache).length;
    const shouldBootstrap = !forceFull && existingCount === 0 && totalCount >= SCORE_BOOTSTRAP_THRESHOLD;

    if (shouldBootstrap) {
      const bootstrapBookmarks = pickBootstrapBookmarks(availableBookmarks, SCORE_BOOTSTRAP_LIMIT);
      const historyStats = new Map();
      const trackingData = { byUrl: new Map(), byTitle: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
      const newCache = {};
      let computedCount = 0;

      for (const bookmark of bootstrapBookmarks) {
        const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
        newCache[bookmark.id] = nextMode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
        computedCount += 1;
        if (computedCount % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      await saveScoresCache(newCache);
      try {
        await browserAPI.storage.local.set({
          recommendScoresStaleMeta: { staleAt: Date.now(), reason: 'bootstrap-partial' }
        });
      } catch (_) { }

      isComputingScores = false;
      scheduleRecomputeAllScoresSoon('bootstrap-full', { forceFull: true });
      return true;
    }

    const [historyStats, trackingData] = await Promise.all([
      getBatchHistoryDataWithTitle(),
      getTrackingDataForScore()
    ]);
    try {
      scoreDebugHistoryStatsCache = { loadedAt: Date.now(), stats: historyStats };
    } catch (_) { }

    let batchCount = 1;
    if (totalCount > 1000) {
      batchCount = 3;
    } else if (totalCount > 500) {
      batchCount = 2;
    }
    const batchSize = Math.ceil(totalCount / batchCount);

    const newCache = {};
    let computedCount = 0;
    for (let i = 0; i < batchCount; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, totalCount);
      const batchBookmarks = availableBookmarks.slice(start, end);

      for (const bookmark of batchBookmarks) {
        const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
        newCache[bookmark.id] = nextMode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
        computedCount += 1;
        // 大量书签时让出事件循环，避免 service worker 长时间无响应
        if (computedCount % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      if (i < batchCount - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    await saveScoresCache(newCache);
    isComputingScores = false;
    return true;
  } catch (error) {
    console.error('[S-score] compute failed:', error);
    isComputingScores = false;
    return false;
  }
}

async function updateSingleBookmarkScore(bookmarkId) {
  try {
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    const bookmarks = await new Promise(resolve => browserAPI.bookmarks.get([bookmarkId], resolve));
    if (!bookmarks || bookmarks.length === 0) return;

    const bookmark = bookmarks[0];
    if (!bookmark || !bookmark.url) return;

    const historyStats = new Map();
    if (browserAPI.history && bookmark.url) {
      const urlKey = normalizeScoreUrlKey(bookmark.url);
      if (urlKey) {
        let visits = await new Promise(resolve => {
          browserAPI.history.getVisits({ url: bookmark.url }, resolve);
        });
        if (!visits?.length) {
          try {
            const u = new URL(bookmark.url);
            u.hash = '';
            const canonicalUrl = u.href;
            if (canonicalUrl && canonicalUrl !== bookmark.url) {
              visits = await new Promise(resolve => {
                browserAPI.history.getVisits({ url: canonicalUrl }, resolve);
              });
            }
          } catch (_) { }
        }
        historyStats.set(urlKey, {
          visitCount: visits?.length || 0,
          lastVisitTime: visits?.length > 0 ? Math.max(...visits.map(v => v.visitTime)) : 0
        });
      }

      if (bookmark.title) {
        historyStats.titleMap = new Map();
        try {
          const historyItems = await new Promise(resolve => {
            browserAPI.history.search({ text: bookmark.title, maxResults: 100 }, resolve);
          });
          for (const item of historyItems) {
            if (item.title?.trim() === bookmark.title.trim()) {
              const existing = historyStats.titleMap.get(bookmark.title) || { visitCount: 0, lastVisitTime: 0 };
              historyStats.titleMap.set(bookmark.title, {
                visitCount: existing.visitCount + (item.visitCount || 0),
                lastVisitTime: Math.max(existing.lastVisitTime, item.lastVisitTime || 0)
              });
            }
          }
        } catch (_) {}
      }
    }

    const [config, trackingData, postponedList, reviewData] = await Promise.all([
      getFormulaConfig(),
      getTrackingDataForScore(),
      getPostponedBookmarksForScore(),
      getReviewDataForScore()
    ]);

    const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
    const mode = await getScoreCacheMode();
    const cache = await getScoresCache();
    cache[bookmarkId] = mode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
    await saveScoresCache(cache);
  } catch (e) {
    console.warn('[S-score] incremental update failed:', e);
  }
}

function collectBookmarkIdsUnderFolders(nodes, folderIdSet, inTarget, output) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    const isTargetBranch = inTarget || (node && folderIdSet.has(String(node.id)));
    if (node && node.url && isTargetBranch) {
      output.push(String(node.id));
    }
    if (node && node.children) {
      collectBookmarkIdsUnderFolders(node.children, folderIdSet, isTargetBranch, output);
    }
  }
}

async function getBookmarkIdsByFolderIds(folderIds) {
  const ids = [];
  const folderIdSet = new Set((folderIds || []).map(id => String(id)).filter(Boolean));
  if (folderIdSet.size === 0 || !browserAPI?.bookmarks?.getTree) return ids;
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  collectBookmarkIdsUnderFolders(tree, folderIdSet, false, ids);
  return [...new Set(ids)];
}

function collectBookmarkIdsByDomains(nodes, domainSet, output) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node && node.url) {
      try {
        const host = normalizeBlockedDomain(new URL(node.url).hostname);
        if (host && domainSet.has(host)) {
          output.push(String(node.id));
        }
      } catch (_) { }
    }
    if (node && node.children) {
      collectBookmarkIdsByDomains(node.children, domainSet, output);
    }
  }
}

async function getBookmarkIdsByDomains(domains) {
  const ids = [];
  const domainSet = new Set((domains || [])
    .map(normalizeBlockedDomain)
    .filter(Boolean));
  if (domainSet.size === 0 || !browserAPI?.bookmarks?.getTree) return ids;
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  collectBookmarkIdsByDomains(tree, domainSet, ids);
  return [...new Set(ids)];
}

function normalizeBookmarkIdList(ids) {
  return Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)
  ));
}

async function getBookmarksByIdsForScore(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0 || !browserAPI?.bookmarks?.get) return [];

  const result = [];
  const chunkSize = 300;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const chunkBookmarks = await new Promise((resolve) => {
      try {
        browserAPI.bookmarks.get(chunk, (items) => {
          if (browserAPI.runtime?.lastError) {
            resolve([]);
            return;
          }
          resolve(Array.isArray(items) ? items : []);
        });
      } catch (_) {
        resolve([]);
      }
    });

    for (const item of chunkBookmarks) {
      if (item && item.url) {
        result.push(item);
      }
    }

    if (i + chunkSize < unique.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return result;
}

async function recomputeScoresForBookmarkIds(ids, options = {}) {
  if (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores) return 0;

  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  const bookmarks = await getBookmarksByIdsForScore(unique);
  if (bookmarks.length === 0) return 0;

  const [historyStats, config, trackingData, postponedList, reviewData, mode, cache] = await Promise.all([
    getBatchHistoryDataWithTitle(),
    getFormulaConfig(),
    getTrackingDataForScore(),
    getPostponedBookmarksForScore(),
    getReviewDataForScore(),
    getScoreCacheMode(),
    getScoresCache()
  ]);

  const batchSize = Math.max(40, Number(options.batchSize) || SCORE_INCREMENTAL_BATCH_SIZE);
  const flushByBatch = options.flushByBatch === true;
  const flushEveryBatches = Math.max(1, Number(options.flushEveryBatches) || 2);
  let updated = 0;
  let processedBatches = 0;

  for (let i = 0; i < bookmarks.length; i += batchSize) {
    const batch = bookmarks.slice(i, i + batchSize);
    for (const bookmark of batch) {
      const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
      cache[String(bookmark.id)] = mode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
      updated += 1;
    }

    processedBatches += 1;

    if (flushByBatch && (processedBatches % flushEveryBatches === 0 || i + batchSize >= bookmarks.length)) {
      await saveScoresCache(cache);
    }

    if (i + batchSize < bookmarks.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (!flushByBatch) {
    await saveScoresCache(cache);
  }

  return updated;
}

async function applyTemplateScoresByIds(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  const [mode, cache] = await Promise.all([
    getScoreCacheMode(),
    getScoresCache()
  ]);

  let updated = 0;
  for (const id of unique) {
    const existing = cache[id];
    const fallbackS = Number.isFinite(existing?.S) ? existing.S : SCORE_TEMPLATE_DEFAULT_S;

    if (mode === SCORE_CACHE_MODE_FULL) {
      cache[id] = {
        S: fallbackS,
        F: Number.isFinite(existing?.F) ? existing.F : SCORE_TEMPLATE_DEFAULT_S,
        C: Number.isFinite(existing?.C) ? existing.C : SCORE_TEMPLATE_DEFAULT_S,
        T: Number.isFinite(existing?.T) ? existing.T : SCORE_TEMPLATE_DEFAULT_S,
        D: Number.isFinite(existing?.D) ? existing.D : SCORE_TEMPLATE_DEFAULT_S,
        L: Number.isFinite(existing?.L) ? existing.L : 0,
        R: Number.isFinite(existing?.R) ? existing.R : 1,
        _template: true
      };
    } else {
      cache[id] = { S: fallbackS, _template: true };
    }
    updated += 1;
  }

  await saveScoresCache(cache);
  return updated;
}

function queueTemplateScoreRefine(ids) {
  const unique = normalizeBookmarkIdList(ids);
  unique.forEach(id => pendingTemplateRefineIds.add(id));

  if (pendingTemplateRefineIds.size === 0) {
    return;
  }

  if (templateRefineTimer) {
    clearTimeout(templateRefineTimer);
  }

  templateRefineTimer = setTimeout(() => {
    templateRefineTimer = null;
    runTemplateScoreRefine().catch((e) => {
      console.warn('[S-score] template refine failed:', e);
    });
  }, SCORE_TEMPLATE_REFINE_DEBOUNCE_MS);
}

async function runTemplateScoreRefine() {
  if (templateRefineRunning) {
    if (pendingTemplateRefineIds.size > 0) {
      queueTemplateScoreRefine([]);
    }
    return;
  }

  if (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores) {
    if (pendingTemplateRefineIds.size > 0) {
      queueTemplateScoreRefine([]);
    }
    return;
  }

  const ids = Array.from(pendingTemplateRefineIds);
  pendingTemplateRefineIds.clear();
  if (ids.length === 0) return;

  templateRefineRunning = true;
  try {
    await recomputeScoresForBookmarkIds(ids, {
      batchSize: SCORE_TEMPLATE_REFINE_BATCH_SIZE,
      flushByBatch: true,
      flushEveryBatches: 2
    });
  } finally {
    templateRefineRunning = false;
    if (pendingTemplateRefineIds.size > 0) {
      queueTemplateScoreRefine([]);
    }
  }
}

async function updateBookmarkScoresByIds(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  if (unique.length <= 3) {
    let updated = 0;
    for (const id of unique) {
      await updateSingleBookmarkScore(id);
      updated += 1;
    }
    return updated;
  }

  if (unique.length >= SCORE_TEMPLATE_BATCH_THRESHOLD) {
    const templated = await applyTemplateScoresByIds(unique);
    queueTemplateScoreRefine(unique);
    return templated;
  }

  return recomputeScoresForBookmarkIds(unique, {
    batchSize: SCORE_INCREMENTAL_BATCH_SIZE,
    flushByBatch: false
  });
}

let pendingUrlUpdates = new Set();
let urlUpdateTimer = null;

async function scheduleScoreUpdateByUrl(url) {
  if (isBookmarkImporting || isBookmarkBulkChanging) return;
  if (!url) return;
  pendingUrlUpdates.add(url);

  if (urlUpdateTimer) clearTimeout(urlUpdateTimer);

  urlUpdateTimer = setTimeout(async () => {
    const urls = [...pendingUrlUpdates];
    pendingUrlUpdates.clear();
    urlUpdateTimer = null;

    try {
      const urlKeySet = new Set(urls.map(normalizeScoreUrlKey).filter(Boolean));
      if (urlKeySet.size === 0) return;

      const indexReady = await ensureBookmarkUrlIndex();
      if (indexReady) {
        const idSet = new Set();
        for (const key of urlKeySet) {
          const ids = bookmarkUrlIndex.get(key);
          if (ids) {
            ids.forEach(id => idSet.add(id));
          }
        }
        if (idSet.size === 0) return;
        for (const bookmarkId of idSet) {
          await updateSingleBookmarkScore(bookmarkId);
        }
        return;
      }

      const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
      const bookmarks = [];
      function traverse(nodes) {
        for (const node of nodes) {
          if (node.url) {
            const key = normalizeScoreUrlKey(node.url);
            if (key && urlKeySet.has(key)) bookmarks.push(node);
          }
          if (node.children) traverse(node.children);
        }
      }
      traverse(tree);

      for (const bookmark of bookmarks) {
        await updateSingleBookmarkScore(bookmark.id);
      }
    } catch (e) {
      console.warn('[S-score] URL update failed:', e);
    }
  }, 1000);
}

  if (browserAPI.history && browserAPI.history.onVisited) {
    browserAPI.history.onVisited.addListener((result) => {
      if (result && result.url) {
        scheduleScoreUpdateByUrl(result.url);
        invalidateScoreDebugHistoryStatsCache();
      }
    });
  }

browserAPI.bookmarks.onCreated.addListener((id, bookmark) => {
  noteBookmarkEventForBulkGuard('created');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  if (bookmark.url) {
    addBookmarkToUrlIndex(bookmark);
    setTimeout(() => updateSingleBookmarkScore(id), 500);
  }
});

browserAPI.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  noteBookmarkEventForBulkGuard('removed');

  const removedBookmarkSet = new Set();
  const removedFolderSet = new Set();

  if (removeInfo && removeInfo.node) {
    collectRemovedNodeIds(removeInfo.node, removedBookmarkSet, removedFolderSet);
  }

  const normalizedId = String(id || '').trim();
  if (normalizedId && removedBookmarkSet.size === 0 && removedFolderSet.size === 0) {
    removedBookmarkSet.add(normalizedId);
    removedFolderSet.add(normalizedId);
  }

  for (const bookmarkId of removedBookmarkSet) {
    removeBookmarkFromUrlIndex(bookmarkId);
  }

  queueRemovedRecommendStatePrune({
    bookmarkIds: Array.from(removedBookmarkSet),
    folderIds: Array.from(removedFolderSet)
  });

  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
});

browserAPI.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  noteBookmarkEventForBulkGuard('changed');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  if (changeInfo.url || changeInfo.title) {
    if (changeInfo.url) {
      updateBookmarkUrlIndex(id, changeInfo.url);
    }
    await updateSingleBookmarkScore(id);
    if (changeInfo.url) {
      try {
        browserAPI.runtime.sendMessage({
          action: 'clearFaviconCache',
          url: changeInfo.url
        }).catch(() => {});
      } catch (_) {}
    }
  }
});

// 移动/重排不直接影响 S 值公式，但在大批量移动时会触发事件风暴：用 bulk guard 兜底降噪
if (browserAPI.bookmarks.onMoved) {
  browserAPI.bookmarks.onMoved.addListener(() => {
    noteBookmarkEventForBulkGuard('moved');
  });
}

// Chrome 书签管理器“导入书签”会触发 onImportBegan/onImportEnded（并伴随大量 onCreated/onMoved 等）
try {
  if (browserAPI.bookmarks.onImportBegan) {
    browserAPI.bookmarks.onImportBegan.addListener(() => {
      isBookmarkImporting = true;
      enterBookmarkBulkChangeMode('import').catch(() => { });
    });
  }
  if (browserAPI.bookmarks.onImportEnded) {
    browserAPI.bookmarks.onImportEnded.addListener(() => {
      isBookmarkImporting = false;
      scheduleBookmarkBulkExit();
    });
  }
} catch (_) { }

// =================================================================================
// Runtime message handler
// =================================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !message.action) {
    sendResponse({ success: false, error: 'Invalid message' });
    return;
  }

  const action = message.action;

  if (action === 'extensionBookmarkOpen') {
    (async () => {
      try {
        const url = message.url;
        const tabId = typeof message.tabId === 'number' ? message.tabId : null;
        const title = typeof message.title === 'string' ? message.title : '';
        const bookmarkId = typeof message.bookmarkId === 'string' ? message.bookmarkId : null;

        if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          sendResponse({ success: false, error: 'Invalid URL' });
          return;
        }

        if (tabId != null) {
          noteAutoBookmarkNavigation({
            tabId,
            bookmarkUrl: url,
            bookmarkId,
            bookmarkTitle: title || '',
            timeStamp: Date.now(),
            source: 'extension'
          });
        }

        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordBrowsingDeletion') {
    (async () => {
      try {
        await recordDeletionForCalibration(message.payload || {});
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordBrowsingInteraction') {
    (async () => {
      try {
        await recordInteractionForCalibration(message.payload || {});
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'resetBrowsingCalibrationState') {
    (async () => {
      try {
        await resetBrowsingCalibrationState(message?.payload?.reason || 'manual');
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'attributedBookmarkOpen') {
    (async () => {
      try {
        const url = message.url;
        const title = typeof message.title === 'string' ? message.title : '';
        const transition = typeof message.transition === 'string' ? message.transition : 'attributed';

        if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          sendResponse({ success: false, error: 'Invalid URL' });
          return;
        }

        await appendPendingAutoBookmarkClick({
          id: `attributed-${Math.floor(Date.now())}`,
          title: title || url,
          url,
          visitTime: Date.now(),
          transition
        });
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'isTrackingEnabled') {
    (async () => {
      try {
        const enabled = await isTrackingEnabled();
        sendResponse({ success: true, enabled });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setTrackingEnabled') {
    (async () => {
      try {
        await setTrackingEnabled(!!message.enabled);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getCurrentActiveSessions') {
    (async () => {
      try {
        const sessions = await getCurrentActiveSessions();
        sendResponse({ success: true, sessions });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getActiveSessions') {
    (async () => {
      try {
        const startTime = Number(message.startTime || 0);
        const endTime = Number(message.endTime || Date.now());
        const sessions = await getSessionsByTimeRange(startTime, endTime);
        sendResponse({ success: true, sessions });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getTrackingStats') {
    (async () => {
      try {
        const stats = await getTrackingStats();
        sendResponse({ success: true, stats });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'clearTrackingDisplayData') {
    (async () => {
      try {
        await clearTrackingDisplayData();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'clearCurrentTrackingSessions') {
    (async () => {
      try {
        await clearCurrentTrackingSessions();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'clearTrackingStatsByRange') {
    (async () => {
      try {
        const range = message.range || 'all';
        const result = await clearTrackingStatsByRange(range);
        sendResponse({ success: true, cleared: result?.cleared || 0 });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'syncTrackingData') {
    (async () => {
      try {
        const result = await syncTrackingData();
        sendResponse({ success: true, result });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordRecommendViewOpen') {
    (async () => {
      try {
        const result = await recordRecommendViewOpenState(message.source);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markRecommendRefreshExecuted') {
    (async () => {
      try {
        const result = await markRecommendRefreshExecutedState();
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'appendRecommendFlippedBookmark') {
    (async () => {
      try {
        const result = await appendRecommendFlippedBookmarkState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markHistoryCurrentCardFlippedState') {
    (async () => {
      try {
        const result = await markHistoryCurrentCardFlippedState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'consumeRecommendPoolCursor') {
    (async () => {
      try {
        const result = await consumeRecommendPoolCursorState(message.poolLength, message.consumeCount);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setRecommendPoolCursor') {
    (async () => {
      try {
        const result = await setRecommendPoolCursorState(message.poolLength, message.cursor);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'appendRecommendFlipHistoryRecord') {
    (async () => {
      try {
        const result = await appendRecommendFlipHistoryRecordState(message.bookmarkId, message.timestamp);
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordRecommendReviewState') {
    (async () => {
      try {
        const result = await recordRecommendReviewState(message.bookmarkId);
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'computeBookmarkScores') {
    (async () => {
      try {
        const ok = await computeAllBookmarkScores();
        // success 表示“本次确实完成了计算并写入缓存”
        sendResponse({ success: !!ok, computed: !!ok });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScore') {
    (async () => {
      try {
        if (message.bookmarkId) {
          await updateSingleBookmarkScore(message.bookmarkId);
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoresByIds') {
    (async () => {
      try {
        const ids = Array.isArray(message.ids)
          ? message.ids
          : (message.bookmarkId ? [message.bookmarkId] : []);
        const updated = await updateBookmarkScoresByIds(ids);
        sendResponse({ success: true, updated, total: ids.length });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoresByFolder') {
    (async () => {
      try {
        const folderIds = Array.isArray(message.folderIds) ? message.folderIds : [message.folderId];
        const ids = await getBookmarkIdsByFolderIds(folderIds);
        const updated = await updateBookmarkScoresByIds(ids);
        sendResponse({ success: true, updated, total: ids.length });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoresByDomain') {
    (async () => {
      try {
        const domains = Array.isArray(message.domains) ? message.domains : [message.domain];
        const ids = await getBookmarkIdsByDomains(domains);
        const updated = await updateBookmarkScoresByIds(ids);
        sendResponse({ success: true, updated, total: ids.length });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoreByUrl') {
    (async () => {
      try {
        if (message.url) {
          await scheduleScoreUpdateByUrl(message.url);
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setRecommendBlockedState') {
    (async () => {
      try {
        const result = await setRecommendBlockedState(message.blocked);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setRecommendPostponedState') {
    (async () => {
      try {
        const result = await setRecommendPostponedState(message.postponed);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'ensureRecommendScoresReady') {
    (async () => {
      try {
        const result = await ensureRecommendScoresReady({ reason: message.reason || '' });
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, ready: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'handleRecommendSkipState') {
    (async () => {
      try {
        const result = await handleRecommendSkipState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'removeRecommendSkippedState') {
    (async () => {
      try {
        const result = await removeRecommendSkippedState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getBookmarkScoreDebug') {
    (async () => {
      try {
        const bookmarkId = String(message.bookmarkId || '').trim();
        if (!bookmarkId) {
          sendResponse({ success: false, error: 'Missing bookmarkId' });
          return;
        }

        const bookmarks = await new Promise(resolve => browserAPI.bookmarks.get([bookmarkId], resolve));
        const bookmark = bookmarks?.[0] || null;
        if (!bookmark || !bookmark.url) {
          sendResponse({ success: false, error: 'Bookmark not found or not a URL bookmark' });
          return;
        }

        const [cache, mode, config, trackingData, postponedList, reviewData, meta] = await Promise.all([
          getScoresCache(),
          getScoreCacheMode(),
          getFormulaConfig(),
          getTrackingDataForScore(),
          getPostponedBookmarksForScore(),
          getReviewDataForScore(),
          browserAPI.storage.local.get(['recommendScoresStaleMeta', 'bookmarkBulkChangeFlag', 'recommend_scores_time', SCORE_ALGO_VERSION_KEY])
        ]);

        const cachedEntry = cache[bookmarkId] || null;
        const historyStats = await getHistoryStatsForScoreDebug();
        const debug = calculateBookmarkScoreDebug(bookmark, historyStats, trackingData, config, postponedList, reviewData);

        const cachedS = typeof cachedEntry?.S === 'number' ? cachedEntry.S : null;
        const computedS = typeof debug?.factors?.S === 'number' ? debug.factors.S : null;

        const notes = [];
        const trackingWarm = (trackingData?.totalMs || 0) >= TRACKING_WARMUP_MIN_MS
          || (trackingData?.totalCount || 0) >= TRACKING_WARMUP_MIN_COUNT;
        const trackingType = debug?.matches?.tracking?.type || 'none';
        if (isBookmarkImporting) notes.push('importing: score recompute paused');
        if (isBookmarkBulkChanging) notes.push('bulk-changing: score recompute paused');
        if (meta?.bookmarkBulkChangeFlag) notes.push('bookmarkBulkChangeFlag=true');
        if (!trackingWarm) notes.push('tracking cold-start: w3 disabled');
        if (trackingType === 'none') notes.push('tracking miss: T neutral=0.5');
        if (cachedEntry && cachedS != null && computedS != null && Math.abs(cachedS - computedS) > 0.02) {
          notes.push(`cache differs from recompute: cached=${cachedS.toFixed(3)} vs recompute=${computedS.toFixed(3)}`);
        }
        if (!cachedEntry) notes.push('no cache entry for this bookmarkId');
        if (cachedEntry && !('F' in cachedEntry)) notes.push('cache mode is compact (only S stored)');

        // 诊断计算后顺手做一次增量缓存更新
        let cacheUpdated = false;
        const canUpdateCache = !isBookmarkImporting && !isBookmarkBulkChanging;
        if (computedS != null && canUpdateCache) {
          const shouldUpdate = !cachedEntry || cachedS == null || Math.abs(cachedS - computedS) > 1e-6;
          if (shouldUpdate) {
            cache[bookmarkId] = mode === SCORE_CACHE_MODE_FULL ? debug.factors : { S: computedS };
            await saveScoresCache(cache);
            cacheUpdated = true;
          }
        } else if (computedS != null && !canUpdateCache) {
          notes.push('cache update skipped due to import/bulk');
        }
        if (cacheUpdated) notes.push('cache updated by debug');

        sendResponse({
          success: true,
          debug: {
            ...debug,
            storage: {
              cacheMode: mode,
              cachedEntry: cachedEntry && typeof cachedEntry === 'object' ? cachedEntry : null,
              recommendScoresTime: Number(meta?.recommend_scores_time || 0),
              staleMeta: meta?.recommendScoresStaleMeta || null,
              algoVersion: Number(meta?.[SCORE_ALGO_VERSION_KEY] || 0)
            },
            notes
          }
        });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'trackingDataUpdated') {
    if (message.url) {
      scheduleScoreUpdateByUrl(message.url);
    }
    return false;
  }

  if (action === 'openSidePanelFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        const view = typeof message.view === 'string'
          ? normalizeHistoryPanelView(message.view, '')
          : null;
        const result = await openSidePanelInWindow(windowId, view);
        if (!result || result.success !== true) {
          sendResponse({ success: false, error: result?.error || 'open_failed' });
          return;
        }
        sendResponse({ success: true, isOpen: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getSidePanelStateFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        if (windowId == null) {
          sendResponse({ success: false, error: 'window_unavailable' });
          return;
        }
        const isOpen = await getSidePanelOpenStateForWindow(windowId);
        sendResponse({ success: true, isOpen });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'closeSidePanelFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        const result = await closeSidePanelInWindow(windowId);
        if (!result || result.success !== true) {
          sendResponse({ success: false, error: result?.error || 'close_failed' });
          return;
        }
        sendResponse({ success: true, isOpen: false });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'toggleSidePanelFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        if (windowId == null) {
          sendResponse({ success: false, error: 'window_unavailable' });
          return;
        }
        const view = typeof message.view === 'string'
          ? normalizeHistoryPanelView(message.view, '')
          : null;
        const isOpen = await getSidePanelOpenStateForWindow(windowId);
        const result = isOpen
          ? await closeSidePanelInWindow(windowId)
          : await openSidePanelInWindow(windowId, view);

        if (!result || result.success !== true) {
          sendResponse({ success: false, error: result?.error || 'toggle_failed' });
          return;
        }

        sendResponse({ success: true, isOpen: result.isOpen === true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markSidePanelOpenFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        if (windowId == null) {
          sendResponse({ success: false, error: 'window_unavailable' });
          return;
        }
        setSidePanelOpenWindowState(windowId, true);
        sendResponse({ success: true, isOpen: true, state: 'opened' });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  sendResponse({ success: false, error: 'Unsupported action' });
});
