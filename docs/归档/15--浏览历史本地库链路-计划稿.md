# Browsing History Library Chain Plan 2026-07-04

## Goal

Make the local browsing history library the authoritative data layer for bookmark-related browsing records across the product.

The intended contract is:

- The browser History API is only a hot-window source, normally used for the recent 90 days.
- The local IndexedDB cache is the cross-90-day source of truth for browsing records accumulated by the current library version.
- First run of this library version discards legacy cache data and seeds a fresh recent-90-day baseline from the browser History API.
- Calibration refreshes the hot window and must not erase current-version cold records unless the user explicitly purges them or a privacy delete policy requires it.
- Features that support day, week, month, year, all, or custom time ranges must read the requested range from the library, not from the currently rendered calendar window.
- Any package or export that cannot prove full coverage must mark the result as partial instead of implying complete history.

## Current Problems

1. Background maintenance uses one `lastSyncTime` for both full calibration and incremental writes. A single visit can make the next background calibration scan too small.
2. The 12-hour background alarm skips when the user is active and does not schedule a near-term retry.
3. Hot-window rebuild can hit the 50k search cap and still replace the whole hot range, which can remove records that were not scanned.
4. Legacy storage handling tried to preserve old bookmark-matched cache rows even though old versions did not maintain an authoritative long-term browsing library.
5. Ranking and several widgets aggregate `calendar.bookmarksByDate`, which is only the current rendered range in the old path.
6. Related records mix full browser history in the hot window with bookmark-related local cache in the cold window.
7. Related/ranking time menus are built from current in-memory calendar records, so year/all/custom menus can be incomplete.
8. Export and sync packages sometimes reuse current calendar state, omit time-range metadata, or label bookmark-related rows as raw browser history.

## Target Architecture

### Background

- Store separate sync metadata:
  - `lastFullSyncTime`: last successful hot-window calibration.
  - `lastIncrementalWriteTime`: last event-driven append.
  - `lastAnyWriteTime`: observability only.
- Background alarm uses `lastFullSyncTime`, not incremental write time.
- If an idle-required run is skipped because the browser is active, schedule a retry alarm.
- If History API pagination reaches the cap, merge scanned rows without replacing the entire unscanned hot range.
- Legacy cache is discarded instead of migrated; the new library starts from a fresh History API hot-window seed.
- Purge resolves only after the IDB transaction commits.

### Frontend Data Access

Add a common range reader in `history.js`:

- `readBrowsingHistoryRowsForRange({ startTime, endTime })`
- `buildBrowsingClickStatsFromRows(rows)`
- helpers for range bounds, date keys, and metadata

Feature code should use this reader for:

- click ranking: day/week/month/year/all/custom
- ranking time menu and secondary filters
- widgets ranking and history trends
- related records snapshots and menus
- search hydration for browsing dates
- export and sync packages

### Semantics

The current library is bookmark-related browsing history, not complete browser history.

Labels and package metadata must reflect that:

- `bookmark_matched_history` for rows matched to bookmarks.
- `partial: true` when data depends on unavailable cold cache.
- `timeRange` must be written into exported manifests and packages.

## Implementation Order

1. Patch background metadata, legacy discard/seed, retry, truncation, and purge correctness.
2. Add frontend range-reader helpers and ranking aggregation from rows.
3. Move click ranking and widgets to range-reader data.
4. Move related record menus and bookmark sets to authoritative bookmarks/range rows.
5. Adjust export/sync package metadata and wording where rows are bookmark-related rather than full native browser history.
6. Run JS syntax checks and diff hygiene checks.

## Acceptance Checks

- Opening click ranking on the default weekly calendar and selecting year/all still reads the full requested range from IDB.
- Custom ranking range outside the current calendar window returns records if they exist in IDB.
- Widgets do not switch from correct fast-path IDB rows back to current calendar-window stats after hydration.
- Related records and related time menus use the same range rows and no longer depend on current calendar view.
- Sync package `manifest.json` contains `timeRange`.
- `raw-native/history-visits.jsonl` is either renamed/marked as bookmark-related or carries clear metadata.
- Background calibration skip due to active state schedules a retry.
- Hot-window truncation does not replace unscanned records.

## Implementation Status

- Done: background sync metadata is split into full sync, incremental write, partial sync, and any-write timestamps.
- Done: idle-required background calibration now schedules a retry alarm after an active-state skip.
- Done: legacy history cache is discarded on first current-library run, then the library seeds a fresh recent-90-day baseline from the History API.
- Done: capped History API scans merge scanned records instead of replacing the unscanned hot range.
- Done: IDB purge resolves after transaction completion.
- Done: click ranking, custom ranking ranges, ranking menus, and ranking secondary filters read from range rows in the local history library.
- Done: related records snapshots and related time menus use the same local library rows and full bookmark reference sets.
- Done: widgets history trend reads the local library first and only falls back to the live calendar when cache reads fail.
- Done: sync push rows are cache-first, time-filtered by record timestamp, and package manifests include `timeRange`.
- Done: browsing history context export reads through the local cache wrapper and labels rows as bookmark-related browsing history.
- Done: frontend IDB cache wrappers now read and preserve split metadata such as `lastFullSyncTime`.
- Done: widgets ranking fast path uses the same local-library row aggregation as the full click ranking path.
- Done: additions-to-related jump checks the local history library before falling back to `history.getVisits`, so older records can still navigate.
- Done: raw-native history export no longer fabricates `bookmarkId` from visit ids, and metadata/labels mark rows as bookmark-related visit facts.
- Done: API fallback sync rows are marked `partial` when a cold window was requested but no cold cache rows are available.
- Done: `scripts/verify-history-library-chain.mjs` provides a Node regression guard for the local-library architecture and 90-day boundary assumptions.
- Done: `scripts/history-library-f12-seed.js` provides a DevTools seed script for synthetic IndexedDB rows across hot, cold, current-year, previous-year, and all-time ranges.
- Done: `scripts/verify-history-feature-flows.mjs` loads the real feature functions in a Node sandbox and automatically verifies click records, click ranking, related records, browsing-history export JSONL, bookmark record packages, raw-native history packages, manifest metadata, and custom time ranges with synthetic hot/cold rows.

Remaining validation:

- Browser runtime QA should verify IndexedDB contents survive extension reloads and that manual calibration updates `lastFullSyncTime`.
- Large-history QA should verify capped scans preserve existing hot-window records while still adding newly scanned records.

## Test Scripts

Run structural regression checks from the repo root:

```bash
node Bookmark-Record-Recommend-main/scripts/verify-history-library-chain.mjs
```

Run function-level automated checks from the repo root:

```bash
node Bookmark-Record-Recommend-main/scripts/verify-history-feature-flows.mjs
```

For browser runtime QA, open the extension page, paste `scripts/history-library-f12-seed.js` into DevTools Console, then reload the extension page and test ranking/year/all/custom/export/sync views. The seed script writes only to the extension IndexedDB cache and exposes cleanup as:

```javascript
__bbHistoryLibraryTestSeed.cleanup()
```
