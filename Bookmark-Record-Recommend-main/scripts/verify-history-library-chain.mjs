#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

const files = {
  background: join(rootDir, 'background.js'),
  history: join(rootDir, 'history_html', 'history.js'),
  calendar: join(rootDir, 'history_html', 'browsing_history_calendar.js'),
  search: join(rootDir, 'history_html', 'search', 'search.js')
};

const source = Object.fromEntries(
  Object.entries(files).map(([key, file]) => [key, readFileSync(file, 'utf8')])
);

const results = [];

function record(ok, label, detail = '') {
  results.push({ ok, label, detail });
}

function check(condition, label, detail = '') {
  record(Boolean(condition), label, detail);
}

function includes(text, needle) {
  return String(text || '').includes(needle);
}

function indexOf(text, needle) {
  return String(text || '').indexOf(needle);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFunctionBodyBraceStart(text, fromIndex) {
  const parenStart = text.indexOf('(', fromIndex);
  if (parenStart < 0) return text.indexOf('{', fromIndex);

  let depth = 0;
  let inString = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = parenStart; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = '';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.indexOf('{', i + 1);
    }
  }

  return -1;
}

function extractFunctionBody(text, name) {
  const safeName = escapeRegExp(name);
  const patterns = [
    new RegExp(`\\b(?:async\\s+)?function\\s+${safeName}\\s*\\(`, 'g'),
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?${safeName}\\s*\\(`, 'g'),
    new RegExp(`\\b(?:const|let|var)\\s+${safeName}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[^=()]+)\\s*=>\\s*\\{`, 'g')
  ];
  let match = null;
  for (const pattern of patterns) {
    match = pattern.exec(text);
    if (match) break;
  }
  if (!match) return '';

  const braceStart = findFunctionBodyBraceStart(text, match.index);
  if (braceStart < 0) return '';

  let depth = 0;
  let inString = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = braceStart; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = '';
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }

  return '';
}

function runSyntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  check(result.status === 0, `syntax: ${file.replace(`${rootDir}/`, '')}`, result.stderr || result.stdout);
}

Object.values(files)
  .filter((file) => !file.endsWith('/search.js'))
  .forEach(runSyntaxCheck);

const background = source.background;
const history = source.history;
const calendar = source.calendar;

const readLastSyncBody = extractFunctionBody(background, 'readBrowsingHistoryLastSyncTime');
const rebuildBody = extractFunctionBody(background, 'rebuildBrowsingHistoryCache');
const runCalibrationBody = extractFunctionBody(background, 'runBrowsingHistoryCalibration');
const purgeIdbBody = extractFunctionBody(background, 'purgeBrowsingHistoryCacheFromIDB');
const migrateLegacyBody = extractFunctionBody(background, 'migrateLegacyBrowsingHistoryCacheToIDB');
const mergeIdbBody = extractFunctionBody(background, 'mergeBrowsingHistoryCacheRecordsMapInIDB');
const writeBackgroundIdbBody = extractFunctionBody(background, 'writeBrowsingHistoryCacheToIDB');
const writeBackgroundCacheBody = extractFunctionBody(background, 'writeBrowsingHistoryCache');

check(includes(background, 'BROWSING_HISTORY_META_LAST_FULL_SYNC'), 'background has split full-sync metadata');
check(includes(background, 'BROWSING_HISTORY_META_LAST_INCREMENTAL_WRITE'), 'background has incremental-write metadata');
check(includes(readLastSyncBody, 'BROWSING_HISTORY_META_LAST_FULL_SYNC') && includes(readLastSyncBody, 'BROWSING_HISTORY_META_LAST_SYNC'), 'background reads full-sync time before legacy lastSyncTime');
check(includes(mergeIdbBody, "'incremental'"), 'incremental IDB merge writes incremental metadata only');
check(includes(migrateLegacyBody, 'mergeBrowsingHistoryRecordItems'), 'legacy migration merges same-day visit records');
check(includes(runCalibrationBody, 'scheduleHistoryBackgroundSyncRetry'), 'idle-active calibration skip schedules retry');
check(includes(purgeIdbBody, 'tx.oncomplete'), 'IDB purge waits for transaction completion');
check(includes(writeBackgroundIdbBody, 'options.replaceExisting') && includes(writeBackgroundIdbBody, 'recordsStore.clear()') && includes(writeBackgroundIdbBody, 'metaStore.clear()'), 'full IDB replace is one transaction');
check(!includes(writeBackgroundCacheBody, 'removeBrowsingHistoryCacheFromIDB'), 'full cache write does not pre-clear IDB separately');
check(!includes(background, 'writeIncrementalBrowsingHistoryCacheToIDB'), 'unused day-overwrite incremental writer removed');
check(includes(rebuildBody, 'historySearchHitLimit') && includes(rebuildBody, 'mergeBrowsingHistoryCacheRecordsMap(normalizedRecordsMap'), 'capped History API scans merge instead of replacing unscanned range');

const readRangeBody = extractFunctionBody(calendar, 'readBrowsingHistoryCacheFromIDBRange');
const writeCalendarIdbBody = extractFunctionBody(calendar, 'writeBrowsingHistoryCacheToIDB');
const handleExportBody = extractFunctionBody(calendar, 'handleExport');

check(includes(calendar, 'BROWSING_HISTORY_META_LAST_FULL_SYNC'), 'calendar wrapper understands split metadata');
check(includes(readRangeBody, 'metaStore.getAll') && includes(readRangeBody, 'normalizeBrowsingHistoryMetaEntries'), 'range reader returns full cache metadata');
check(includes(writeCalendarIdbBody, 'putBrowsingHistoryCacheMeta'), 'calendar legacy migration writes full-sync metadata');
check(includes(handleExportBody, 'readHistoryCacheRange') && includes(handleExportBody, 'bookmark_related_browsing_history'), 'history_context export reads cache wrapper and labels bookmark-related rows');
check(!includes(handleExportBody, 'chrome.history.search'), 'history_context export does not bypass local cache with History API');

const readRowsBody = extractFunctionBody(history, 'readBrowsingHistoryLibraryRowsForBounds');
const ensureRankingBody = extractFunctionBody(history, 'ensureBrowsingClickRankingStats');
const customRankingBody = extractFunctionBody(history, 'getBrowsingRankingItemsForCustomRange');
const filterRankingBody = extractFunctionBody(history, 'filterRankingItemsByTime');
const relatedSnapshotBody = extractFunctionBody(history, 'buildBrowsingRelatedSnapshotForRange');
const relatedMenuBody = extractFunctionBody(history, 'showBrowsingRelatedTimeMenu');
const widgetsFastBody = extractFunctionBody(history, 'buildWidgetsRankingFastStats');
const syncResolveBody = extractFunctionBody(history, 'resolveSyncBrowsingCacheRows');
const syncApiBody = extractFunctionBody(history, 'resolveSyncBrowsingRowsFromHistoryApi');
const normalizeVisitBody = extractFunctionBody(history, 'normalizeSyncHistoryVisitRecord');
const historyJsonlBody = extractFunctionBody(history, 'buildHistoryVisitsJsonlExport');
const jumpFromAdditionsBody = extractFunctionBody(history, 'jumpToRelatedHistoryFromAdditions');
const visitStatsBody = extractFunctionBody(history, 'getBookmarkVisitStats');

check(includes(readRowsBody, 'readHistoryCacheRange') && includes(readRowsBody, 'filterBrowsingCacheRowsByTime'), 'shared range reader reads local history cache and filters by visit time');
check(includes(ensureRankingBody, 'readBrowsingHistoryLibraryRowsForBounds') && !includes(ensureRankingBody, 'calendar.bookmarksByDate'), 'click ranking uses local range rows, not current calendar map');
check(includes(customRankingBody, 'readBrowsingHistoryLibraryRowsForBounds') && !includes(customRankingBody, 'calendar.bookmarksByDate'), 'custom ranking ranges use local range rows');
check(includes(filterRankingBody, 'forEachBrowsingRankingStatsRecord') && !includes(filterRankingBody, 'calendar.bookmarksByDate'), 'ranking secondary filters use cached row stats');
check(includes(relatedSnapshotBody, 'readBrowsingHistoryLibraryRowsForBounds') && !includes(relatedSnapshotBody, 'history.search'), 'related snapshots use local range rows');
check(includes(relatedMenuBody, 'ensureBrowsingClickRankingStats') && !includes(relatedMenuBody, 'calendar.bookmarksByDate'), 'related time menu uses local-library stats');
check(includes(widgetsFastBody, 'buildBrowsingClickRankingStatsFromRows'), 'widgets fast ranking uses the same aggregation as full ranking');

const syncApiFallbackAt = indexOf(syncResolveBody, 'resolveSyncBrowsingRowsFromHistoryApi');
const syncCacheRangeAt = indexOf(syncResolveBody, 'readHistoryCacheRange');
check(syncCacheRangeAt >= 0 && syncApiFallbackAt > syncCacheRangeAt, 'sync rows are cache-first before History API fallback');
check(includes(syncApiBody, 'partialReason') && includes(syncApiBody, 'missing_cold_cache'), 'History API fallback marks missing cold-cache coverage as partial');
check(includes(normalizeVisitBody, 'record.bookmarkId == null ? null : String(record.bookmarkId)') && !includes(normalizeVisitBody, 'record.bookmarkId || record.id'), 'raw history export does not fabricate bookmarkId from visit id');
check(includes(historyJsonlBody, "scope: 'bookmark_related_history'"), 'history-visits jsonl declares bookmark-related scope');
check(includes(jumpFromAdditionsBody, 'readBrowsingHistoryLibraryRowsForBounds') && indexOf(jumpFromAdditionsBody, 'readBrowsingHistoryLibraryRowsForBounds') < indexOf(jumpFromAdditionsBody, 'history.getVisits'), 'additions-to-related jump checks local history library before getVisits fallback');
check(includes(visitStatsBody, 'readBrowsingHistoryLibraryRowsForBounds'), 'single URL visit stats are local-cache first');

const failed = results.filter((item) => !item.ok);
const passed = results.filter((item) => item.ok);

for (const item of passed) {
  console.log(`ok - ${item.label}`);
}

for (const item of failed) {
  console.error(`not ok - ${item.label}`);
  if (item.detail) console.error(String(item.detail).trim());
}

console.log(`\n${passed.length} passed, ${failed.length} failed`);

if (failed.length > 0) {
  process.exitCode = 1;
}
