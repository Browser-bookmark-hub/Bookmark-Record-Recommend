/*
 * Paste this file into the DevTools console of an extension page.
 * It writes synthetic bookmark-related browsing rows and matching synthetic
 * bookmark references into extension caches only. It does not write to
 * Chrome's real history database or create real browser bookmarks.
 */
(() => {
  const DB_NAME = 'BookmarkBrowsingHistoryCacheDB';
  const DB_VERSION = 1;
  const RECORD_STORE = 'records';
  const META_STORE = 'meta';
  const ADDITIONS_CACHE_KEY = 'bb_cache_additions_v1';
  const ADDITIONS_WIDGETS_SNAPSHOT_KEY = 'bb_widgets_additions_snapshot_v1';
  const TEST_MARKER = '__bbHistoryLibraryTestSeed';
  const TEST_URL_PREFIX = 'https://history-cache-test.local/';
  const DAY_MS = 24 * 60 * 60 * 1000;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  function waitForTransaction(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function extensionStorageGet(keys) {
    return new Promise((resolve) => {
      try {
        const list = Array.isArray(keys) ? keys : [keys].filter(Boolean);
        const area = chrome?.storage?.local;
        if (!area?.get) {
          const result = {};
          for (const key of list) {
            const raw = localStorage.getItem(key);
            if (raw) result[key] = JSON.parse(raw);
          }
          resolve(result);
          return;
        }
        area.get(list, (result) => {
          const err = chrome?.runtime?.lastError;
          if (err) {
            console.warn('[history-library-test-seed] storage.get failed:', err.message || err);
            resolve({});
            return;
          }
          resolve(result && typeof result === 'object' ? result : {});
        });
      } catch (error) {
        console.warn('[history-library-test-seed] storage.get failed:', error);
        resolve({});
      }
    });
  }

  function extensionStorageSet(payload) {
    return new Promise((resolve) => {
      try {
        const area = chrome?.storage?.local;
        if (!area?.set) {
          Object.entries(payload || {}).forEach(([key, value]) => {
            localStorage.setItem(key, JSON.stringify(value));
          });
          resolve(true);
          return;
        }
        area.set(payload, () => {
          const err = chrome?.runtime?.lastError;
          if (err) {
            console.warn('[history-library-test-seed] storage.set failed:', err.message || err);
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch (error) {
        console.warn('[history-library-test-seed] storage.set failed:', error);
        resolve(false);
      }
    });
  }

  function openDb() {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('indexedDB is unavailable on this page'));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error || new Error('Failed to open history cache DB'));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(RECORD_STORE)) {
          db.createObjectStore(RECORD_STORE, { keyPath: 'dateKey' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'key' });
        }
      };
    });
  }

  function dateKey(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function localTime(year, month, day, hour = 10, minute = 0) {
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  }

  function flattenBookmarkNodes(nodes, parentPath = [], output = []) {
    for (const node of (Array.isArray(nodes) ? nodes : [])) {
      const title = String(node?.title || '').trim();
      const nextPath = title ? parentPath.concat(title) : parentPath;
      if (node?.url) {
        output.push({
          id: node.id == null ? '' : String(node.id),
          title: title || String(node.url || ''),
          url: String(node.url || ''),
          dateAdded: Number(node.dateAdded || Date.now()) || Date.now(),
          parentId: node.parentId == null ? '' : String(node.parentId),
          path: nextPath.join('/')
        });
      }
      if (Array.isArray(node?.children)) {
        flattenBookmarkNodes(node.children, nextPath, output);
      }
    }
    return output;
  }

  async function readRealBookmarkReferences(options = {}) {
    if (options.useRealBookmarks === false) return [];
    if (!chrome?.bookmarks?.getTree) return [];
    const tree = await new Promise((resolve) => {
      try {
        const maybePromise = chrome.bookmarks.getTree((result) => {
          const err = chrome?.runtime?.lastError;
          if (err) {
            console.warn('[history-library-test-seed] bookmarks.getTree failed:', err.message || err);
            resolve([]);
            return;
          }
          resolve(Array.isArray(result) ? result : []);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((result) => resolve(Array.isArray(result) ? result : [])).catch(() => resolve([]));
        }
      } catch (error) {
        console.warn('[history-library-test-seed] bookmarks.getTree failed:', error);
        resolve([]);
      }
    });
    const refs = flattenBookmarkNodes(tree)
      .filter((item) => item.url && !String(item.url).startsWith('javascript:'));
    const maxRefs = Math.max(1, Math.min(20, Number(options.maxBookmarkRefs || 7) || 7));
    return refs.slice(0, maxRefs);
  }

  function makeRecord(label, timestamp, index, extra = {}, bookmarkRef = null) {
    const slug = String(label || 'row').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    const hasRealBookmark = bookmarkRef && bookmarkRef.url && !String(bookmarkRef.url).startsWith(TEST_URL_PREFIX);
    const url = String(bookmarkRef?.url || `${TEST_URL_PREFIX}${slug}`);
    const title = String(bookmarkRef?.title || `History Library Test ${label}`);
    const pathParts = String(bookmarkRef?.path || '').split('/').filter(Boolean);
    const folderPath = pathParts.length > 1 ? pathParts.slice(0, -1) : ['History Library Test'];
    return {
      id: `${TEST_MARKER}:${slug}:${timestamp}:${index}`,
      title,
      url,
      dateAdded: timestamp,
      visitTime: timestamp,
      lastVisitTime: timestamp,
      visitCount: Math.max(1, Number(extra.visitCount || 1) || 1),
      typedCount: Math.max(0, Number(extra.typedCount || 0) || 0),
      transition: extra.transition || 'link',
      referringVisitId: null,
      bookmarkId: bookmarkRef?.id || (extra.bookmarkId == null ? `seed-bookmark-${index}` : String(extra.bookmarkId)),
      folderPath,
      matchType: 'seeded_test',
      source: TEST_MARKER,
      realBookmarkSeed: hasRealBookmark,
      seedLabel: label,
      testMarker: TEST_MARKER
    };
  }

  function buildSeedRecords(options = {}, bookmarkRefs = []) {
    const now = Date.now();
    const current = new Date(now);
    const thisYear = current.getFullYear();
    const samples = [
      ['today-hot', now - 2 * 60 * 60 * 1000, { visitCount: 2 }],
      ['yesterday-hot', now - DAY_MS, { visitCount: 1 }],
      ['inside-90-days', now - 45 * DAY_MS, { visitCount: 3 }],
      ['outside-90-days', now - 120 * DAY_MS, { visitCount: 4 }],
      ['this-year-cold', localTime(thisYear, 1, 15, 9, 30), { visitCount: 5 }],
      ['previous-year', localTime(thisYear - 1, 6, 10, 14, 20), { visitCount: 6 }],
      ['four-hundred-days', now - 400 * DAY_MS, { visitCount: 7 }]
    ];

    const repeatCount = Math.max(1, Math.min(20, Number(options.repeatCount || 1) || 1));
    const records = [];
    for (let round = 0; round < repeatCount; round += 1) {
      samples.forEach(([label, timestamp, extra], index) => {
        const ref = bookmarkRefs.length ? bookmarkRefs[index % bookmarkRefs.length] : null;
        records.push(makeRecord(label, timestamp + round * 1000, index + round * samples.length, extra, ref));
      });
    }
    return records;
  }

  function groupByDate(records) {
    const rows = new Map();
    for (const record of records) {
      const key = dateKey(record.visitTime || record.dateAdded);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(record);
    }
    return rows;
  }

  function buildSeedBookmarkReferences(records) {
    const seenUrls = new Set();
    return (Array.isArray(records) ? records : [])
      .filter((record) => String(record?.url || '').startsWith(TEST_URL_PREFIX))
      .filter((record) => {
        const url = String(record?.url || '');
        if (!url || seenUrls.has(url)) return false;
        seenUrls.add(url);
        return true;
      })
      .map((record, index) => ({
        id: record.bookmarkId || `${TEST_MARKER}:bookmark:${index}`,
        title: record.title || record.url || '',
        url: record.url || '',
        dateAdded: Math.max(1, Number(record.visitTime || record.dateAdded || Date.now()) - DAY_MS),
        parentId: `${TEST_MARKER}:folder`,
        path: `History Library Test/${record.title || record.url || index}`,
        ancestorFolderIds: [`${TEST_MARKER}:folder`],
        testMarker: TEST_MARKER
      }))
      .filter((entry) => entry.url);
  }

  function buildAdditionsWidgetsSnapshot(bookmarks) {
    const days = 45;
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    const countByKey = {};
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(base);
      date.setDate(base.getDate() - i);
      countByKey[dateKey(date.getTime())] = 0;
    }
    for (const item of (Array.isArray(bookmarks) ? bookmarks : [])) {
      const key = dateKey(Number(item?.dateAdded || 0));
      if (Object.prototype.hasOwnProperty.call(countByKey, key)) {
        countByKey[key] = Number(countByKey[key] || 0) + 1;
      }
    }
    return { ts: Date.now(), days, countByKey };
  }

  async function seedBookmarkReferences(records) {
    const seedBookmarks = buildSeedBookmarkReferences(records);
    const existing = await extensionStorageGet([ADDITIONS_CACHE_KEY]);
    const currentPayload = existing?.[ADDITIONS_CACHE_KEY] && typeof existing[ADDITIONS_CACHE_KEY] === 'object'
      ? existing[ADDITIONS_CACHE_KEY]
      : {};
    const currentBookmarks = Array.isArray(currentPayload.bookmarks) ? currentPayload.bookmarks : [];
    const keptBookmarks = currentBookmarks.filter((item) => {
      if (item?.testMarker === TEST_MARKER) return false;
      return !String(item?.url || '').startsWith(TEST_URL_PREFIX);
    });
    const nextBookmarks = keptBookmarks.concat(seedBookmarks);
    const ok = await extensionStorageSet({
      [ADDITIONS_CACHE_KEY]: {
        ...currentPayload,
        timestamp: Date.now(),
        totalBookmarks: nextBookmarks.length,
        bookmarks: nextBookmarks
      },
      [ADDITIONS_WIDGETS_SNAPSHOT_KEY]: buildAdditionsWidgetsSnapshot(nextBookmarks)
    });
    return {
      ok,
      insertedBookmarks: seedBookmarks.length,
      previousSeedBookmarks: currentBookmarks.length - keptBookmarks.length,
      totalBookmarks: nextBookmarks.length
    };
  }

  async function seed(options = {}) {
    const db = await openDb();
    const realBookmarkRefs = await readRealBookmarkReferences(options);
    const seedRecords = buildSeedRecords(options, realBookmarkRefs);
    const rows = groupByDate(seedRecords);
    const tx = db.transaction([RECORD_STORE, META_STORE], 'readwrite');
    const recordStore = tx.objectStore(RECORD_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const changedDateKeys = [];
    let inserted = 0;

    for (const [key, records] of rows.entries()) {
      const existing = await requestToPromise(recordStore.get(key));
      const existingItems = Array.isArray(existing?.items) ? existing.items : [];
      const kept = existingItems.filter((item) => {
        if (item?.testMarker === TEST_MARKER) return false;
        return !String(item?.url || '').startsWith(TEST_URL_PREFIX);
      });
      recordStore.put({ dateKey: key, items: kept.concat(records) });
      changedDateKeys.push(key);
      inserted += records.length;
    }

    const now = Date.now();
    metaStore.put({ key: 'lastSyncTime', value: now });
    metaStore.put({ key: 'lastFullSyncTime', value: now });
    metaStore.put({ key: 'lastAnyWriteTime', value: now });

    await waitForTransaction(tx);
    const bookmarkReferences = await seedBookmarkReferences(seedRecords);
    return {
      ok: true,
      inserted,
      insertedBookmarks: bookmarkReferences.insertedBookmarks,
      sourceMode: realBookmarkRefs.length ? 'real-bookmarks' : 'synthetic-bookmark-cache',
      changedDateKeys: changedDateKeys.sort(),
      bookmarkReferences,
      rankingTargets: Array.from(new Map(seedRecords.map((record) => [
        record.seedLabel,
        {
          label: record.seedLabel,
          dateKey: dateKey(record.visitTime),
          title: record.title,
          url: record.url
        }
      ])).values()),
      note: realBookmarkRefs.length
        ? 'Reload the extension page, then check click ranking for the listed real bookmark titles/URLs.'
        : 'Reload the extension page, then test ranking/year/all/custom/export/sync views. No real bookmarks were readable, so synthetic bookmark references were cached.'
    };
  }

  async function cleanup() {
    const db = await openDb();
    const tx = db.transaction(RECORD_STORE, 'readwrite');
    const recordStore = tx.objectStore(RECORD_STORE);
    let removed = 0;
    let touchedDateKeys = 0;

    await new Promise((resolve, reject) => {
      const request = recordStore.openCursor();
      request.onerror = () => reject(request.error || new Error('Cursor failed'));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          resolve(true);
          return;
        }
        const value = cursor.value || {};
        const items = Array.isArray(value.items) ? value.items : [];
        const kept = items.filter((item) => {
          if (item?.testMarker === TEST_MARKER) return false;
          return !String(item?.url || '').startsWith(TEST_URL_PREFIX);
        });
        removed += items.length - kept.length;
        if (kept.length !== items.length) {
          touchedDateKeys += 1;
          if (kept.length > 0) {
            cursor.update({ ...value, items: kept });
          } else {
            cursor.delete();
          }
        }
        cursor.continue();
      };
    });

    await waitForTransaction(tx);
    const existing = await extensionStorageGet([ADDITIONS_CACHE_KEY]);
    const currentPayload = existing?.[ADDITIONS_CACHE_KEY] && typeof existing[ADDITIONS_CACHE_KEY] === 'object'
      ? existing[ADDITIONS_CACHE_KEY]
      : {};
    const currentBookmarks = Array.isArray(currentPayload.bookmarks) ? currentPayload.bookmarks : [];
    const keptBookmarks = currentBookmarks.filter((item) => {
      if (item?.testMarker === TEST_MARKER) return false;
      return !String(item?.url || '').startsWith(TEST_URL_PREFIX);
    });
    const removedBookmarks = currentBookmarks.length - keptBookmarks.length;
    if (removedBookmarks > 0) {
      await extensionStorageSet({
        [ADDITIONS_CACHE_KEY]: {
          ...currentPayload,
          timestamp: Date.now(),
          totalBookmarks: keptBookmarks.length,
          bookmarks: keptBookmarks
        },
        [ADDITIONS_WIDGETS_SNAPSHOT_KEY]: buildAdditionsWidgetsSnapshot(keptBookmarks)
      });
    }
    return { ok: true, removed, touchedDateKeys, removedBookmarks };
  }

  window.__bbHistoryLibraryTestSeed = {
    seed,
    cleanup,
    buildSeedRecords,
    buildSeedBookmarkReferences,
    constants: { DB_NAME, RECORD_STORE, META_STORE, ADDITIONS_CACHE_KEY, TEST_MARKER, TEST_URL_PREFIX }
  };

  return seed(window.__BB_HISTORY_TEST_OPTIONS__ || {})
    .then((summary) => {
      console.log('[history-library-test-seed] seeded', summary);
      return summary;
    })
    .catch((error) => {
      console.error('[history-library-test-seed] failed', error);
      throw error;
    });
})();
