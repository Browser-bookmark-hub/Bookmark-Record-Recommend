#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const historyJsPath = join(rootDir, 'history_html', 'history.js');
const browsingCalendarJsPath = join(rootDir, 'history_html', 'browsing_history_calendar.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const results = [];

function record(ok, label, detail = '') {
  results.push({ ok: Boolean(ok), label, detail: String(detail || '') });
}

function assert(ok, label, detail = '') {
  record(ok, label, detail);
  if (!ok) {
    throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
  }
}

function dateKey(timestamp) {
  const d = new Date(timestamp);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

function localTime(year, month, day, hour = 10, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function groupRows(records) {
  const map = new Map();
  for (const record of records) {
    const key = dateKey(record.visitTime || record.dateAdded);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function flattenRows(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => Array.isArray(row?.[1]) ? row[1] : []);
}

function countRows(rows) {
  return flattenRows(rows).length;
}

function rowHasUrl(rows, url) {
  return flattenRows(rows).some((record) => String(record?.url || '') === url);
}

function makeSeedData() {
  const now = Date.now();
  const currentYear = new Date(now).getFullYear();
  const previousYear = currentYear - 1;
  const timestamps = {
    hotTodayA: now - 2 * HOUR_MS,
    hotTodayB: now - HOUR_MS,
    inside90: now - 45 * DAY_MS,
    outside90: now - 120 * DAY_MS,
    thisYearCold: localTime(currentYear, 1, 15, 9, 30),
    previousYear: localTime(previousYear, 6, 10, 14, 20),
    fourHundredDays: now - 400 * DAY_MS,
    nullBookmarkId: localTime(previousYear, 8, 5, 16, 45)
  };

  const definitions = [
    ['hot-today-a', timestamps.hotTodayA, 'seed-bookmark-hot'],
    ['hot-today-b', timestamps.hotTodayB, 'seed-bookmark-hot'],
    ['inside-90-days', timestamps.inside90, 'seed-bookmark-inside-90'],
    ['outside-90-days', timestamps.outside90, 'seed-bookmark-outside-90'],
    ['this-year-cold', timestamps.thisYearCold, 'seed-bookmark-this-year'],
    ['previous-year', timestamps.previousYear, 'seed-bookmark-previous-year'],
    ['four-hundred-days', timestamps.fourHundredDays, 'seed-bookmark-400'],
    ['null-bookmark-id', timestamps.nullBookmarkId, null]
  ];

  const records = definitions.map(([slug, timestamp, bookmarkId], index) => {
    const url = `https://history-feature-test.local/${slug}`;
    return {
      id: `feature-seed-${slug}-${timestamp}`,
      bookmarkId,
      title: `Feature Seed ${slug}`,
      url,
      dateAdded: timestamp,
      visitTime: timestamp,
      lastVisitTime: timestamp,
      visitCount: slug === 'outside-90-days' ? 4 : 1,
      typedCount: slug === 'inside-90-days' ? 1 : 0,
      transition: 'link',
      referringVisitId: null,
      folderPath: ['Feature Flow Test'],
      matchType: 'seeded_test',
      testMarker: 'history-feature-flow'
    };
  });

  const additionsRecords = records.map((record, index) => ({
    id: record.bookmarkId || `seed-bookmark-null-${index}`,
    title: record.title,
    url: record.url,
    dateAdded: Math.max(1, record.visitTime - DAY_MS),
    path: `Feature Flow Test/${record.title}`
  }));

  const bookmarkTree = {
    id: '0',
    title: '',
    children: [{
      id: '1',
      title: 'Feature Flow Test',
      children: additionsRecords.map((item) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        dateAdded: item.dateAdded
      }))
    }]
  };

  return {
    now,
    currentYear,
    previousYear,
    timestamps,
    urls: Object.fromEntries(records.map((record) => [
      String(record.url).replace('https://history-feature-test.local/', '').replace(/-/g, '_'),
      record.url
    ])),
    records,
    rows: groupRows(records),
    additionsRecords,
    bookmarkTree,
    startAll: Math.min(...records.map((record) => record.visitTime)) - DAY_MS,
    endAll: now + DAY_MS
  };
}

function filterRowsByDateKey(rows, startKey = '', endKey = '') {
  return rows.filter(([key]) => {
    const safeKey = String(key || '');
    if (startKey && safeKey < startKey) return false;
    if (endKey && safeKey > endKey) return false;
    return true;
  });
}

function createElementStub() {
  const element = {
    style: {},
    dataset: {},
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    checked: true,
    disabled: false,
    parentElement: null,
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() {}
    },
    appendChild(child) {
      if (child && typeof child === 'object') child.parentElement = element;
      return child;
    },
    insertBefore(child) {
      if (child && typeof child === 'object') child.parentElement = element;
      return child;
    },
    removeChild() {},
    remove() {},
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    select() {},
    click() {}
  };
  return element;
}

function createSandbox(seed) {
  const storageData = {
    bb_cache_additions_v1: { timestamp: seed.now, bookmarks: seed.additionsRecords },
    timetracking_blocked: { bookmarks: [], folders: [], domains: [] }
  };
  const context = {
    console: {
      log() {},
      info() {},
      warn() {},
      error() {}
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    URLSearchParams,
    TextEncoder,
    crypto: globalThis.crypto,
    Map,
    Set,
    WeakMap,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Math,
    RegExp,
    JSON,
    Promise,
    Error,
    Blob: class Blob {
      constructor(parts = [], options = {}) {
        this.parts = parts;
        this.type = options.type || '';
      }
    },
    URL: {
      createObjectURL() { return 'blob:history-feature-flow'; },
      revokeObjectURL() {}
    },
    navigator: {
      language: 'zh-CN',
      clipboard: { writeText: async () => {} }
    },
    localStorage: {
      getItem(key) {
        if (key === 'browsingRelatedActiveRange') return 'all';
        return null;
      },
      setItem() {},
      removeItem() {}
    },
    alert() {},
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    }
  };

  const documentStub = {
    head: createElementStub(),
    body: createElementStub(),
    documentElement: createElementStub(),
    createElement() { return createElementStub(); },
    createTextNode(text = '') { return { textContent: String(text) }; },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true; },
    getElementById() { return createElementStub(); },
    querySelector(selector) {
      if (String(selector).includes('browsingExportMode')) {
        return { value: context.__exportMode || 'history_context', checked: true };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (String(selector).includes('browsingExportFormat')) {
        return (context.__exportFormats || ['jsonl']).map((value) => ({ value, checked: true }));
      }
      return [];
    }
  };

  const chrome = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      lastError: null,
      sendMessage: async (message) => {
        if (message?.action === 'getTrackingRankingStatsByRange') {
          return { success: true, stats: {} };
        }
        return { success: true };
      },
      onMessage: { addListener() {} },
      getURL: (path = '') => `chrome-extension://test/${path}`
    },
    storage: {
      local: {
        get(keys, callback) {
          const list = Array.isArray(keys) ? keys : [keys].filter(Boolean);
          const result = {};
          for (const key of list) {
            if (Object.prototype.hasOwnProperty.call(storageData, key)) {
              result[key] = storageData[key];
            }
          }
          if (typeof callback === 'function') callback(result);
          return Promise.resolve(result);
        },
        set(payload, callback) {
          Object.assign(storageData, payload || {});
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        },
        remove(keys, callback) {
          const list = Array.isArray(keys) ? keys : [keys].filter(Boolean);
          for (const key of list) delete storageData[key];
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        }
      }
    },
    bookmarks: {
      getTree(callback) {
        callback([seed.bookmarkTree]);
      }
    },
    history: {},
    downloads: {
      download(_options, callback) {
        if (typeof callback === 'function') callback(1);
      }
    }
  };

  context.document = documentStub;
  context.chrome = chrome;
  context.browser = chrome;
  context.window = {
    window: null,
    document: documentStub,
    localStorage: context.localStorage,
    navigator: context.navigator,
    chrome,
    browser: chrome,
    location: { search: '' },
    addEventListener() {},
    removeEventListener() {},
    open() {},
    __ALLOWED_VIEWS: ['sync'],
    __DEFAULT_VIEW: 'sync'
  };
  context.window.window = context.window;
  context.globalThis = context;
  context.__seed = seed;
  context.__downloads = [];
  context.__readHistoryCacheRange = async (startKey = '', endKey = '') => ({
    lastSyncTime: seed.now,
    lastFullSyncTime: seed.now,
    records: filterRowsByDateKey(seed.rows, String(startKey || ''), String(endKey || ''))
  });
  context.__readHistoryCacheValue = async (key = '') => {
    if (key === 'bb_cache_browsing_history_v1') {
      return { lastSyncTime: seed.now, lastFullSyncTime: seed.now, records: seed.rows };
    }
    return null;
  };
  return context;
}

function installHistoryGlobals(context, seed) {
  context.__bookmarkData = {
    urls: new Set(seed.additionsRecords.map((item) => item.url)),
    titles: new Set(seed.additionsRecords.map((item) => item.title)),
    info: new Map(seed.additionsRecords.map((item) => [
      item.url,
      {
        url: item.url,
        title: item.title,
        folderPath: ['Feature Flow Test']
      }
    ]))
  };
  vm.runInContext(`
    currentLang = 'zh_CN';
    allBookmarks = globalThis.__seed.additionsRecords.slice();
    browsingClickRankingStats = null;
    browsingRelatedBookmarkUrls = null;
    browsingRelatedBookmarkTitles = null;
    browsingRelatedBookmarkInfo = null;
    browsingRelatedSortAsc = false;
    syncDocsState = [];
    syncConfigState = {
      remoteProvider: 'local',
      bookmarkRecord: true,
      bookmarkRecommend: false,
      rawNative: true,
      syncOutputNamingVersion: '0.3.9',
      syncOutputNamingMode: 'range-v2'
    };
    syncPushTimeRange = 'custom';
    syncPushCustomRange = {
      startTime: globalThis.__seed.startAll,
      endTime: globalThis.__seed.endAll
    };
    readHistoryCacheRange = globalThis.__readHistoryCacheRange;
    readHistoryCacheValue = globalThis.__readHistoryCacheValue;
    window.browsingHistoryCalendarInstance = {
      bookmarksByDate: new Map(),
      dbManager: {
        getBookmarksDB() {
          return {
            getAllUrls() { return globalThis.__bookmarkData.urls; },
            getAllTitles() { return globalThis.__bookmarkData.titles; }
          };
        }
      }
    };
  `, context);
}

async function runHistoryFeatureChecks(context, seed) {
  const rangeRows = await context.readBrowsingHistoryLibraryRowsForBounds(seed.startAll, seed.endAll);
  assert(countRows(rangeRows.rows) === seed.records.length, '书签点击记录: 本地库范围读取覆盖全部测试访问', `got ${countRows(rangeRows.rows)}`);
  assert(rowHasUrl(rangeRows.rows, seed.urls.outside_90_days), '书签点击记录: 120 天前冷数据可被范围读取');
  assert(rowHasUrl(rangeRows.rows, seed.urls.previous_year), '书签点击记录: 去年冷数据可被范围读取');

  const rankingStats = await context.ensureBrowsingClickRankingStats();
  const allRanking = context.getBrowsingRankingItemsForRangeFromStats(rankingStats, 'all');
  const yearRanking = context.getBrowsingRankingItemsForRangeFromStats(rankingStats, 'year');
  assert(allRanking.some((item) => item.url === seed.urls.previous_year), '点击排行: 全部时间包含去年访问');
  assert(allRanking.some((item) => item.url === seed.urls.four_hundred_days), '点击排行: 全部时间包含 400 天前访问');
  assert(yearRanking.some((item) => item.url === seed.urls.this_year_cold), '点击排行: 本年包含年初冷数据');
  assert(!yearRanking.some((item) => item.url === seed.urls.previous_year), '点击排行: 本年不会混入去年访问');

  const previousDayStart = localTime(seed.previousYear, 6, 10, 0, 0);
  const previousDayEnd = localTime(seed.previousYear, 6, 10, 23, 59) + 59 * 1000;
  const customRanking = await context.getBrowsingRankingItemsForCustomRange(previousDayStart, previousDayEnd);
  assert(customRanking.some((item) => item.url === seed.urls.previous_year), '点击排行: 自定义时间命中去年访问');
  assert(!customRanking.some((item) => item.url === seed.urls.hot_today_a), '点击排行: 自定义时间不会混入今天访问');

  const relatedSnapshot = await context.buildBrowsingRelatedSnapshotForRange('all', {
    ignoreCustomBounds: true,
    calendar: context.window.browsingHistoryCalendarInstance,
    silent: true
  });
  const relatedUrls = new Set((relatedSnapshot.historyItemsExpanded || []).map((item) => item.url));
  assert(relatedUrls.has(seed.urls.outside_90_days), '关联记录: all 快照包含 120 天前冷数据');
  assert(relatedUrls.has(seed.urls.previous_year), '关联记录: all 快照包含去年冷数据');
}

async function runSyncPackageChecks(context, seed) {
  const syncConfig = {
    remoteProvider: 'local',
    bookmarkRecord: true,
    bookmarkRecommend: false,
    rawNative: true,
    syncOutputNamingVersion: '0.3.9',
    syncOutputNamingMode: 'range-v2'
  };
  const payload = await context.collectSyncPushPayload(syncConfig);
  assert(payload?.timeRange?.range === 'custom', '推送与分析: 快照 payload 记录自定义时间范围');

  const bookmarkRecords = payload?.packages?.bookmarkRecords;
  const clickRows = bookmarkRecords?.data?.clickRecords?.rows || [];
  assert(countRows(clickRows) === seed.records.length, '书签记录包: clickRecords 覆盖全部测试访问', `got ${countRows(clickRows)}`);
  assert(rowHasUrl(clickRows, seed.urls.outside_90_days), '书签记录包: clickRecords 包含 120 天前冷数据');
  assert(rowHasUrl(clickRows, seed.urls.previous_year), '书签记录包: clickRecords 包含去年冷数据');
  assert(bookmarkRecords?.summary?.clickRankingCount > 0, '书签记录包: 生成点击排行');
  assert((bookmarkRecords?.data?.relatedRecords?.snapshots || []).some((snapshot) => (
    (snapshot.items || []).some((item) => item.url === seed.urls.previous_year)
  )), '书签记录包: relatedRecords 包含去年冷数据');

  const rawHistory = payload?.rawNative?.historyVisits;
  assert(rawHistory?.scope === 'bookmark_related_history', '原生数据包: historyVisits 标注 bookmark_related_history');
  assert(rawHistory?.recordCount === seed.records.length, '原生数据包: historyVisits recordCount 覆盖全部测试访问', `got ${rawHistory?.recordCount}`);

  const snapshot = {
    schema: 'bookmark_record_and_recommend.ai-cloud-snapshot.v2',
    updatedAt: payload.generatedAt,
    pushId: 'feature-flow-test',
    pushConfig: syncConfig,
    payload,
    docs: []
  };
  const exportBundle = await context.buildSyncExportFiles(snapshot, syncConfig, {
    provider: 'local',
    writeMode: 'local-functional-test'
  });
  const files = exportBundle.files || [];
  const bookmarkRecordFile = files.find((file) => file.path.endsWith('data/packages/bookmark-record.json'));
  const historyJsonlFile = files.find((file) => file.path.endsWith('data/raw-native/history-visits.jsonl'));
  const manifestFile = files.find((file) => file.path.endsWith('data/manifest.json'));
  assert(bookmarkRecordFile, '推送 / 导出快照包: 生成 bookmark-record.json');
  assert(historyJsonlFile, '推送 / 导出快照包: 生成 raw-native/history-visits.jsonl');
  assert(manifestFile, '推送 / 导出快照包: 生成 data/manifest.json');

  const bookmarkRecordPackage = JSON.parse(bookmarkRecordFile.text);
  assert(bookmarkRecordPackage?.timeRange?.range === 'custom', '推送 / 导出快照包: bookmark-record.json 保留自定义时间范围');
  assert(rowHasUrl(bookmarkRecordPackage?.data?.clickRecords?.rows || [], seed.urls.previous_year), '推送 / 导出快照包: bookmark-record.json 包含去年点击记录');

  const historyLines = String(historyJsonlFile.text || '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert(historyLines.some((line) => line.url === seed.urls.previous_year), '推送 / 导出快照包: history-visits.jsonl 包含去年访问');
  const nullBookmarkLine = historyLines.find((line) => line.url === seed.urls.null_bookmark_id);
  assert(nullBookmarkLine && nullBookmarkLine.bookmarkId === null, '推送 / 导出快照包: history-visits.jsonl 不用 visit id 伪造 bookmarkId');

  const manifest = JSON.parse(manifestFile.text);
  const rawHistoryEntry = (manifest.files || []).find((entry) => entry.role === 'raw-native-history');
  assert(manifest?.timeRange?.range === 'custom', '推送 / 导出快照包: manifest 保留自定义时间范围');
  assert(rawHistoryEntry?.scope === 'bookmark_related_history', '推送 / 导出快照包: manifest 标注 raw-native-history scope');
}

async function runBrowsingExportChecks(context, seed) {
  const calendarSource = readFileSync(browsingCalendarJsPath, 'utf8');
  vm.runInContext(calendarSource, context, { filename: browsingCalendarJsPath });
  vm.runInContext(`
    readHistoryCacheRange = globalThis.__readHistoryCacheRange;
    readHistoryCacheValue = globalThis.__readHistoryCacheValue;
  `, context);
  context.__exportMode = 'history_context';
  context.__exportFormats = ['jsonl'];
  context.__downloads = [];
  context.document.getElementById = (id) => {
    const el = createElementStub();
    el.id = id;
    el.innerHTML = id === 'doBrowsingExportBtn' ? 'Export' : '';
    return el;
  };

  const selectedDates = [dateKey(seed.startAll), dateKey(seed.endAll)];
  await vm.runInContext(`
    (async () => {
      const cal = Object.create(BrowsingHistoryCalendar.prototype);
      cal.bookmarksByDate = new Map([['${dateKey(seed.now)}', [{ url: 'seed', title: 'seed' }]]]);
      cal.currentYear = new Date(globalThis.__seed.now).getFullYear();
      cal.currentMonth = new Date(globalThis.__seed.now).getMonth();
      cal.currentDay = new Date(globalThis.__seed.now);
      cal.currentWeekStart = new Date(globalThis.__seed.now - 6 * 24 * 60 * 60 * 1000);
      cal.viewLevel = 'month';
      cal.selectMode = true;
      cal.selectedDates = new Set(${JSON.stringify(selectedDates)});
      cal.currentExportScope = null;
      cal.getExportData = async () => ({ children: [{ title: 'feature-flow-export' }] });
      cal.generateExportFilename = () => 'feature_flow_history_context';
      cal.downloadFile = (content, filename, type) => {
        globalThis.__downloads.push({ content, filename, type });
      };
      cal.copyToClipboard = async () => {};
      await cal.handleExport();
    })()
  `, context);

  const historyExport = (context.__downloads || []).find((item) => String(item.filename || '').includes('书签相关浏览历史'));
  assert(historyExport, '导出书签点击记录及浏览历史: 生成书签相关浏览历史 JSONL');
  const lines = String(historyExport.content || '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert(lines.some((line) => line.url === seed.urls.outside_90_days), '导出书签点击记录及浏览历史: JSONL 包含 120 天前冷数据');
  assert(lines.some((line) => line.url === seed.urls.previous_year), '导出书签点击记录及浏览历史: JSONL 包含去年冷数据');
}

async function main() {
  const seed = makeSeedData();
  const context = createSandbox(seed);
  vm.createContext(context);
  const historySource = readFileSync(historyJsPath, 'utf8');
  vm.runInContext(historySource, context, { filename: historyJsPath });
  installHistoryGlobals(context, seed);

  await runHistoryFeatureChecks(context, seed);
  await runSyncPackageChecks(context, seed);
  await runBrowsingExportChecks(context, seed);

  for (const item of results) {
    console.log(`ok - ${item.label}`);
  }
  console.log(`\n${results.length} passed, 0 failed`);
}

main().catch((error) => {
  const passed = results.filter((item) => item.ok);
  const failedLabels = new Set(results.filter((item) => !item.ok).map((item) => item.label));
  for (const item of passed) {
    console.log(`ok - ${item.label}`);
  }
  if (!failedLabels.has(error.message)) {
    console.error(`not ok - ${error.message}`);
  }
  console.error(`\n${passed.length} passed, 1 failed`);
  process.exitCode = 1;
});
