## Switch to [中文文档](docs/README/README.zh.md)...

[![Linux.do](https://img.shields.io/badge/Linux.do-Portfolio-FFD700?logo=discourse&logoColor=white)](https://linux.do/u/kk1/activity/portfolio)
[![GitHub Releases](https://img.shields.io/github/v/release/Browser-bookmark-hub/Bookmark-Record-Recommend?logo=github&logoColor=white&label=GitHub+Releases)](https://github.com/Browser-bookmark-hub/Bookmark-Record-Recommend/releases)
[![Microsoft Edge Add-ons](https://img.shields.io/badge/Edge_Add--ons-Available-0078D7?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/hdoajmdijappigkbiiefbhkfifbfoleb)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ehodmhbidnoegdodnceiepdekgeoggck?color=0F9D58&logo=googlechrome&logoColor=white&label=Chrome+Web+Store)](https://chromewebstore.google.com/detail/ehodmhbidnoegdodnceiepdekgeoggck)

### Overview
`Bookmark Record and Recommend` is an enhanced extension for power bookmark users. It reawakens your knowledge base through three core engines: "Bookmark Records", "Smart Recommendations", and "AI Push".
It uses an S-Score algorithm for dynamic recommendations and processes all complex data computations locally. The "raw data + computed results" can be downloaded locally or synced to GitHub, allowing AI to perform deep analysis out-of-the-box using `AGENTS.md` / `CLAUDE.md` rules, bypassing the heavy raw computation burden.

It is also an ecosystem-related project for [Bookmark-Canvas](https://github.com/Browser-bookmark-hub/Bookmark-Canvas), with [exported JSON files](docs/PUSH_AND_ANALYZE_STRUCTURE.md) compatible with Bookmark Canvas import formats for temporary sections and notes.

### Preview

#### Screenshot Preview
| Sidebar | Recommend |
| :---: | :---: |
| <img src="Screenshots%20and%20icons/v0.3/侧边栏%20en.png" width="400"> | <img src="Screenshots%20and%20icons/v0.3/推荐公式%20en.png" width="400"> |
| **Bookmark Record** | **Push & Analyze** |
| <img src="Screenshots%20and%20icons/v0.3/书签记录%20en.png" width="400"> | <img src="Screenshots%20and%20icons/v0.3/推送与分析%20en.png" width="400"> |
| **Related Records** | **Add to Review** |
| <img src="Screenshots%20and%20icons/v0.4.5/关联记录en.png" width="400"> | <img src="Screenshots%20and%20icons/v0.4.5/添加到待复习en.png" width="400"> |

### Roadmap
- [ ] **More languages**: the current UI was mainly built around Chinese and English. Traditional Chinese, French, Russian, Spanish, Arabic, Japanese, Korean, and other languages are welcome as community contributions. README translations can be added under [`docs/README/`](docs/README/). See [`docs/LIMITATIONS_AND_COMPROMISES.md#4`](docs/LIMITATIONS_AND_COMPROMISES.md#4-语言切换与新增语言需要重构或共建).
- [ ] **Documentation co-building**: contributions are welcome for `AGENTS.md` / `CLAUDE.md` rule files, so different AI clients can better understand sync packages, output formats, and analysis boundaries. See [`AGENTS_template`](Bookmark-Record-Recommend-main/history_html/AGENTS_template/).
- [ ] **Ecosystem and data processing**: continue exploring Bookmark Canvas integration, recommendation packages, AI analysis results, CLI tools for data processing, and local knowledge-base / RAG directions; this is still exploratory.
- [ ] **Browser platform limitations tracking**: continue tracking browser API changes, platform capability boundaries, and browser bug fixes. See [`docs/LIMITATIONS_AND_COMPROMISES.md`](docs/LIMITATIONS_AND_COMPROMISES.md).

### Docs
- [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md): current project structure and module map
- [`docs/S_SCORE_ALGORITHM_V6_4.md`](docs/S_SCORE_ALGORITHM_V6_4.md): current S-score v6.4, maintained buckets, and push structure
- [`docs/PUSH_AND_ANALYZE_STRUCTURE.md`](docs/PUSH_AND_ANALYZE_STRUCTURE.md): Push & Analyze structure preview
- [`docs/LIMITATIONS_AND_COMPROMISES.md`](docs/LIMITATIONS_AND_COMPROMISES.md): limitations and implementation compromises
- [`docs/归档/00--归档索引-请先读.md`](docs/%E5%BD%92%E6%A1%A3/00--%E5%BD%92%E6%A1%A3%E7%B4%A2%E5%BC%95-%E8%AF%B7%E5%85%88%E8%AF%BB.md): historical archive index and deletion candidates

### Changelog
> [!NOTE]
> #### v0.4.8
> - **Export ecosystem expansion**: Push & Analyze and manual exports can target GitHub, local files, or both. GitHub manual exports are organized under `manual-export/<category>/<date>/` and remain separate from normal sync and pull flows. Related Records now supports right-click context exports for any item, configurable before/after ranges, and preserved orange-selection semantics; Click Ranking adds single-item exports.
> - **UX and documentation polish**: recommendation modes now include notes on backup/restore and S-score recalculation; favicon warm-up is capped at 150 unique domains; bookmark-event API audit and multilingual documentation groundwork were added.

### Core Algorithms
Most views, filters, and exports can be rebuilt from the raw bookmark tree, browsing history, plus data processing or AI analysis. The three sections below are the plugin's real core: Bookmark Recommendation S-Score, Active-Time Tracking, and the Local Browsing-History Library. Replacing them would still require substantial state maintenance and algorithm code. The code blocks are core examples extracted from the current implementation; full logic lives in the linked modules.

#### Bookmark Recommendation S-Score
Full implementation: [`background.js`](Bookmark-Record-Recommend-main/background.js).

```js
function calculateFactorValue(value, threshold, inverse = false) {
  // inverse=true is used by F/C/T; inverse=false is used by D.
  if (value <= 0) return inverse ? 1 : 0;
  const safeThreshold = Math.max(1, threshold || 1);
  const decayed = 1 / (1 + Math.pow(value / safeThreshold, 0.7));
  return inverse ? decayed : (1 - decayed);
}

// F/C/T/D/L/R map to freshness, coldness, shallow-read, forgetting, review-later, and review memory.
const F = calculateFactorValue(daysSinceAdded, thresholds.freshness, true);
const C = calculateFactorValue(history.visitCount, thresholds.coldness, true);
const T = trackingHit
  ? calculateFactorValue(compositeMinutes, thresholds.shallowRead, true)
  : TRACKING_NEUTRAL_T;
const D = calculateFactorValue(daysSinceLastVisit, thresholds.forgetting, false);
const L = laterResult.L;
const R = reviewResult.R;

// Ignore T before tracking has warmed up, then re-normalize the remaining weights.
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

// Keep the cached S-score reproducible: no randomness, clamped between 0 and 1.
const basePriority = w1 * F + w2 * C + w3 * T + w4 * D + w5 * L;
const S = Math.max(0, Math.min(1, basePriority * R));
```

#### Active-Time Tracking
Full implementation: [`active_time_tracker/index.js`](Bookmark-Record-Recommend-main/active_time_tracker/index.js).

The core is not the stored record shape. Browser API events maintain four time buckets, and saving the session folds those buckets into `compositeMs`.

```js
const compositeMs = session.accumulatedActiveMs +
  (session.pauseTotalMs * 0.8) +
  (session.visibleTotalMs * 0.5) +
  (session.backgroundTotalMs * 0.1);
```

`accumulatedActiveMs` comes from ACTIVE spans where the tab is current, the window is focused, and the user is active. The other three buckets are entered by API-driven transitions.

```js
if (currentWindowFocused && currentIdleState === 'active') {
  if (session.state === SessionState.PAUSED) {
    session.resume(); // following ACTIVE spans accumulate into accumulatedActiveMs
  }
}

if (wasActive && newState !== 'active') {
  if (session.state === SessionState.ACTIVE) {
    session.pauseForIdle(); // foreground page remains, but the user is idle: pauseTotalMs
  }
}

if (!currentWindowFocused && session.state === SessionState.ACTIVE) {
  session.pauseForVisible(); // browser lost focus while the page stays visible: visibleTotalMs
}

if (tid !== tabId && session.state === SessionState.ACTIVE) {
  session.pauseForBackground(); // switched to another tab: backgroundTotalMs
}
```

#### Local Browsing-History Library: Hot-Bucket Replace and Cold-Bucket Retention
Full implementation: [`background.js`](Bookmark-Record-Recommend-main/background.js) and [`browsing_history_calendar.js`](Bookmark-Record-Recommend-main/history_html/browsing_history_calendar.js).

The browser History API is only used as the calibration source for the recent roughly 90-day hot window. Automatic sync expands from the last sync time to 3-90 days, manual calibration can align the full 90-day window, and the local IndexedDB library keeps cold data outside that window so browsing history can go beyond the API hot window.

```js
let scanDays = 90;
if (isAdaptiveBrowsingHistoryCalibrationReason(reason) && lastSyncTime > 0) {
  const timePassedMs = now - lastSyncTime;
  const timePassedDays = Math.ceil(timePassedMs / (24 * 60 * 60 * 1000));
  scanDays = Math.min(90, Math.max(3, timePassedDays + 2)); // Clamp auto hot-window sync to 3-90 days, with a 2-day buffer.
}

const scanLimitMs = scanDays * 24 * 60 * 60 * 1000;
const apiCutoffTime = now - scanLimitMs; // History API only calibrates the hot-window floor.
const effectiveStartTime = Math.max(cutoffTime, apiCutoffTime);
const effectiveEndTime = now;
const rebuildChunks = createBrowsingHistoryRebuildChunks(effectiveStartTime, effectiveEndTime); // Flush the hot window back in chunks.
```

When replacing the hot bucket, only the covered time span is deleted. Same-day records outside the hot-window boundary are retained first as cold data.

```js
const retainedItems = items.filter((item) => {
  const timestamp = getBrowsingHistoryRecordTimestamp(item);
  if (!timestamp) return true; // Records without timestamps are not safe to delete.
  if (startTime && timestamp < startTime) return true; // Left side of the hot window is cold data.
  if (endTime && timestamp > endTime) return true; // Right side is retained too.
  return false;
});

if (retainedItems.length) {
  retainedMap.set(dateKey, retainedItems); // Keep same-day cold rows before replacing.
}
mergedMap.delete(dateKey); // Clear the hot-bucket date before writing fresh hot rows.
```

When the 50k cap is hit, the hot bucket is not replaced; only scanned records are merged.

```js
if (historySearchHitLimit) {
  if (normalizedRecordsMap.size === 0) return true;
  return await mergeBrowsingHistoryCacheRecordsMap(normalizedRecordsMap, now); // Merge scanned rows only; do not replace an incomplete hot bucket.
}
```

Only a complete hot window writes back: newly scanned hot rows are merged with retained cold rows, then the consumed retained rows are cleared.

```js
for (const [dateKey, items] of recordsMap.entries()) {
  if (!dateKey || dateKey < startDateKey || dateKey > endDateKey) continue; // Write only the current hot-window dates.
  mergedMap.set(dateKey, mergeBrowsingHistoryRecordItems(
    retainedMap.get(dateKey) || [],
    items || []
  )); // Deduplicate fresh hot rows with retained cold rows.
  retainedMap.delete(dateKey); // Consumed retained rows must not be written twice.
}
```

### Data & Privacy
- **Local Storage by Default**: Core states are stored locally in browser storage (no dedicated backend service).
- **Optional GitHub Cloud Sync**: Supports uploading/downloading your data and documents to your personal GitHub repository.
- Permissions include bookmarks/history/tabs to support full functionality.
- Favicons may be loaded from the browser's built-in favicon service or public favicon providers, then persisted in local cache.
- For more details, please refer to our [Privacy Policy (`PRIVACY_POLICY.md`)](Bookmark-Record-Recommend-main/PRIVACY_POLICY.md)



---

## License

GPL-3.0

## [Back to top](#switch-to-中文文档)
