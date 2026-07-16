## Switch to [English](#english)

[![Linux.do](https://img.shields.io/badge/Linux.do-Portfolio-FFD700?logo=discourse&logoColor=white)](https://linux.do/u/kk1/activity/portfolio)
[![GitHub Releases](https://img.shields.io/github/v/release/Browser-bookmark-hub/Bookmark-Record-Recommend?logo=github&logoColor=white&label=GitHub+Releases)](https://github.com/Browser-bookmark-hub/Bookmark-Record-Recommend/releases)
[![Microsoft Edge Add-ons](https://img.shields.io/badge/Edge_Add--ons-Available-0078D7?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/hdoajmdijappigkbiiefbhkfifbfoleb)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ehodmhbidnoegdodnceiepdekgeoggck?color=0F9D58&logo=googlechrome&logoColor=white&label=Chrome+Web+Store)](https://chromewebstore.google.com/detail/ehodmhbidnoegdodnceiepdekgeoggck)

### 简介
`书签记录与推荐` 是一款为重度用户打造的增强型扩展，通过“书签记录”、“智能推荐”与“AI 推送”三大核心引擎唤醒你的知识库。
它基于 S 值算法实现动态推荐，并在本地完成所有复杂的关联计算。“原始数据 + 计算结果”可直接下载到本地或推送到 GitHub，让 AI 结合 `AGENTS.md` / `CLAUDE.md` 规则“开箱即用”地进行深度分析，免去了处理生数据的算力负担。

它也是 [书签画布（Bookmark-Canvas）](https://github.com/Browser-bookmark-hub/Bookmark-Canvas) 生态的关联项目，导出的 JSON 文件兼容书签画布导入的标签与备注格式。

### 路线图
- [ ] **语言增加与调试**：当前主要围绕中英文实现，后续繁体中文、法语、俄语、西班牙语、阿拉伯语、日语、韩语等语言欢迎共建。限制说明见 [`../docs/LIMITATIONS_AND_COMPROMISES.md#4`](../docs/LIMITATIONS_AND_COMPROMISES.md#4-语言切换与新增语言需要重构或共建)。
- [ ] **文档共建**：欢迎共建 `AGENTS.md` / `CLAUDE.md` 约束文件，让不同 AI 客户端更好理解同步包、输出格式和分析边界。模板入口见 [`AGENTS_template`](history_html/AGENTS_template/)。
- [ ] **生态与数据处理探索**：围绕书签画布、推荐数据包、AI 分析结果、面向数据处理的 CLI 工具，以及本地知识库 / RAG 方向继续探索，目前仍处于探索阶段。
- [ ] **浏览器平台限制持续关注**：持续跟进浏览器 API 变化、平台能力边界与浏览器自身 bug 修复，相关约束和取舍见 [`../docs/LIMITATIONS_AND_COMPROMISES.md`](../docs/LIMITATIONS_AND_COMPROMISES.md)。

### 相关文档
- [`../docs/PROJECT_STRUCTURE.md`](../docs/PROJECT_STRUCTURE.md)：当前项目结构与模块定位
- [`../docs/S_SCORE_ALGORITHM_V6_4.md`](../docs/S_SCORE_ALGORITHM_V6_4.md)：当前 S 值算法 v6.4、维护桶与推送结构
- [`../docs/LIMITATIONS_AND_COMPROMISES.md`](../docs/LIMITATIONS_AND_COMPROMISES.md)：限制与实现妥协
- [`../docs/归档/00--归档索引-请先读.md`](../docs/%E5%BD%92%E6%A1%A3/00--%E5%BD%92%E6%A1%A3%E7%B4%A2%E5%BC%95-%E8%AF%B7%E5%85%88%E8%AF%BB.md)：历史计划归档与删除候选

### 更新日志
> [!NOTE]
> #### v0.4.5
> - **浏览历史持久化升级**：浏览记录链路从依赖浏览器 History API 的即时查询，迁移到本地持久缓存与维护桶，点击历史可突破原先约 90 天窗口；同步、删除、迁移和修复逻辑也随之重构。
> - **导出生态与书签画布兼容**：扩展点击排行、关联记录、正在追踪、时间排行、待复习、添加至复习等导出；JSON 补齐标签/备注语义与临时栏目结构，服务于 [Bookmark-Canvas](https://github.com/Browser-bookmark-hub/Bookmark-Canvas) 的导入与整理流程。
> - **默认快捷键调整**：
>   - `Ctrl/Command+Shift+6`：激活扩展。
>   - `Ctrl/Command+Shift+7`：打开推荐视图。
>   - `Ctrl/Command+Shift+8`：打开记录视图。
>   - `Ctrl/Command+Shift+9`：快捷复习下一张卡片。
> - **体验与性能修复**：关联记录改为更轻的滑动/懒加载窗口，减少大数据量下的卡顿；同时包含小组件 UI、硬件加速、favicon 删除机制、折叠队列清理等细节修复。

### 核心算法
大部分视图、筛选和导出都可以基于原始书签树、浏览记录，再加上数据处理或 AI 分析重建；下面三块才是插件真正的核心能力：书签推荐 S 值计算公式、时间追踪、浏览历史本地库。它们即使被替代，也需要重新实现大量状态维护和算法代码。代码块是从当前实现抽出的核心示例，完整逻辑见对应模块。

#### 书签推荐 S 值计算公式
完整实现见 [`background.js`](background.js)。

```js
function calculateFactorValue(value, threshold, inverse = false) {
  // inverse=true 用于 F/C/T：数值越大，因子越低；inverse=false 用于 D：越久未访问，因子越高。
  if (value <= 0) return inverse ? 1 : 0;
  const safeThreshold = Math.max(1, threshold || 1);
  const decayed = 1 / (1 + Math.pow(value / safeThreshold, 0.7));
  return inverse ? decayed : (1 - decayed);
}

// F/C/T/D/L/R 分别对应新鲜度、冷门度、浅阅读、遗忘度、待复习和复习记忆。
const F = calculateFactorValue(daysSinceAdded, thresholds.freshness, true);
const C = calculateFactorValue(history.visitCount, thresholds.coldness, true);
const T = trackingHit
  ? calculateFactorValue(compositeMinutes, thresholds.shallowRead, true)
  : TRACKING_NEUTRAL_T;
const D = calculateFactorValue(daysSinceLastVisit, thresholds.forgetting, false);
const L = laterResult.L;
const R = reviewResult.R;

// 追踪未热身时移除 T 权重，避免少量时间数据过早影响推荐。
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

// S 值缓存要求可复现，不加入随机项，最终限制在 0 到 1 之间。
const basePriority = w1 * F + w2 * C + w3 * T + w4 * D + w5 * L;
const S = Math.max(0, Math.min(1, basePriority * R));
```

#### 时间追踪
完整实现见 [`active_time_tracker/index.js`](active_time_tracker/index.js)。

核心不是展示记录字段，而是让浏览器 API 事件维护四个时间桶；保存时再把四个桶按权重合成一个可用于推荐的 `compositeMs`。

```js
const compositeMs = session.accumulatedActiveMs +
  (session.pauseTotalMs * 0.8) +
  (session.visibleTotalMs * 0.5) +
  (session.backgroundTotalMs * 0.1);
```

`accumulatedActiveMs` 来自当前标签、窗口聚焦、用户 active 的 ACTIVE 时段；另外三个桶由 API 迁移触发。

```js
if (currentWindowFocused && currentIdleState === 'active') {
  if (session.state === SessionState.PAUSED) {
    session.resume(); // 后续 ACTIVE 时段累计到 accumulatedActiveMs
  }
}

if (wasActive && newState !== 'active') {
  if (session.state === SessionState.ACTIVE) {
    session.pauseForIdle(); // 前台页未切走但用户 idle：pauseTotalMs
  }
}

if (!currentWindowFocused && session.state === SessionState.ACTIVE) {
  session.pauseForVisible(); // 浏览器失焦但页面仍可见：visibleTotalMs
}

if (tid !== tabId && session.state === SessionState.ACTIVE) {
  session.pauseForBackground(); // 切到其他标签页：backgroundTotalMs
}
```

#### 浏览历史本地库：热桶替换与冷桶保留
完整实现见 [`background.js`](background.js) 与 [`browsing_history_calendar.js`](history_html/browsing_history_calendar.js)。

浏览器 History API 只作为最近约 90 天热窗的校准源：自动同步按上次同步时间扩到 3-90 天，手动校准可完整对齐 90 天；IndexedDB 本地库负责保留热窗之外的冷数据，从而让浏览历史突破 API 热窗限制。

```js
let scanDays = 90;
if (isAdaptiveBrowsingHistoryCalibrationReason(reason) && lastSyncTime > 0) {
  const timePassedMs = now - lastSyncTime;
  const timePassedDays = Math.ceil(timePassedMs / (24 * 60 * 60 * 1000));
  scanDays = Math.min(90, Math.max(3, timePassedDays + 2)); // 自动热窗限制在 3-90 天，并加 2 天缓冲。
}

const scanLimitMs = scanDays * 24 * 60 * 60 * 1000;
const apiCutoffTime = now - scanLimitMs; // History API 只负责校准热窗下界。
const effectiveStartTime = Math.max(cutoffTime, apiCutoffTime);
const effectiveEndTime = now;
const rebuildChunks = createBrowsingHistoryRebuildChunks(effectiveStartTime, effectiveEndTime); // 热窗按 chunk 写回本地库。
```

替换热桶时，只删除当前热窗覆盖的时间段；同一天里超出热窗边界的记录会先进入 `retainedMap`，作为冷数据保留。

```js
const retainedItems = items.filter((item) => {
  const timestamp = getBrowsingHistoryRecordTimestamp(item);
  if (!timestamp) return true; // 无时间戳记录不能安全删除。
  if (startTime && timestamp < startTime) return true; // 热窗左侧是冷数据。
  if (endTime && timestamp > endTime) return true; // 热窗右侧也保留。
  return false;
});

if (retainedItems.length) {
  retainedMap.set(dateKey, retainedItems); // 先暂存同日冷数据。
}
mergedMap.delete(dateKey); // 清空热桶日期，等待新热数据写回。
```

命中 50k 上限时不进入热桶替换，只合并已扫描记录。

```js
if (historySearchHitLimit) {
  if (normalizedRecordsMap.size === 0) return true;
  return await mergeBrowsingHistoryCacheRecordsMap(normalizedRecordsMap, now); // 只合并已扫描记录，不替换未扫描热区。
}
```

完整热窗才写回：新热数据和 `retainedMap` 里的冷数据合并，随后清掉已消化的保留项。

```js
for (const [dateKey, items] of recordsMap.entries()) {
  if (!dateKey || dateKey < startDateKey || dateKey > endDateKey) continue; // 只写当前热窗日期。
  mergedMap.set(dateKey, mergeBrowsingHistoryRecordItems(
    retainedMap.get(dateKey) || [],
    items || []
  )); // 新热数据 + retainedMap 冷数据去重合并。
  retainedMap.delete(dateKey); // 已合并的冷数据不再二次写入。
}
```

### 预览

#### 推送与分析结构图预览
`Base Path` 可在「推送与分析」的 GitHub 配置中设置，默认留空；设置后下面结构整体位于 `<Base Path>/书签记录与推荐/`。目录不存在时，首次推送会随文件写入自动出现在 GitHub 仓库中。
生成逻辑见 [`history_html/history.js`](history_html/history.js)。
```text
书签记录与推荐/
|-- AGENTS.md                             [PUSH] 同步/AI 分析规则文档：固定写入 Base Path 下的产品文件夹，限定可读路径、结果格式、manifest 与 pushId 聚合流程。
|-- data/manifest.json                    [PUSH] AI 入口索引：列出本次 pushId、正文文件、hash、读取顺序；不包含正文或本地变化摘要。
|-- data/packages/bookmark-record.json    [PUSH] 书签记录包：新增、点击、点击排行、关联记录、当前时间排行与时间屏蔽状态。
|-- data/packages/bookmark-recommend.json [PUSH] 书签推荐包：S 分数池、候选池、推荐模式、复习、屏蔽、跳过、翻卡事件。
|-- data/raw-native/bookmarks-tree.json   [PUSH] 书签树/准原生事实源：Phase A 标注 source 与 flattened-records 格式。
|-- data/raw-native/history-visits.jsonl  [PUSH] 浏览历史事实源：JSONL 明细，manifest 标注 limit 与 truncated。
|-- ai/input-docs/index.json              [PUSH] “查看”区输入文档索引：记录任务 Markdown 的文件名与更新时间。
|-- ai/input-docs/*.md                    [PULL/PUSH] 输入任务文档：你在“查看”里维护；本地/云端删除会按拉取或推送同步。
|-- ai/results/**/*.md                    [PULL/PUSH] AI 输出结果文档：拉取查看；本地编辑、重命名、删除后随下次推送同步。
|-- GitHub /commits?sha=<branch>          [READ] 仓库提交时间线：查看最近改动文件与变更频率。
|-- GitHub /compare/<base>...<head>       [READ] 按 pushId 聚合后的差异摘要：查看业务文件变化；不生成本地变化摘要。
|-- meta/sync_state.json                  [PUSH] 同步状态元数据：最近推送时间、分支、推送文件数、文档数量。
\-- manual-export/                        [MANUAL] 手动导出目录：仅在导出面板选择 GitHub 时写入；普通推送或拉取不会处理，分类见下方。
    |-- click-ranking/<YYYY-MM-DD>/       [MANUAL] 手动导出分类：点击排行，按导出日期分组。
    |-- current-tracking/<YYYY-MM-DD>/    [MANUAL] 手动导出分类：正在追踪，按导出日期分组。
    |-- time-ranking/<YYYY-MM-DD>/        [MANUAL] 手动导出分类：时间排行，按导出日期分组。
    |-- related-history/<YYYY-MM-DD>/     [MANUAL] 手动导出分类：关联记录，按导出日期分组。
    |-- postponed-review/<YYYY-MM-DD>/    [MANUAL] 手动导出分类：待复习，按导出日期分组。
    |-- bookmark-status/<YYYY-MM-DD>/     [MANUAL] 手动导出分类：书签情况，按导出日期分组。
    |-- bookmark-addition-records/<YYYY-MM-DD>/ [MANUAL] 手动导出分类：书签添加记录，按导出日期分组。
    \-- bookmark-click-records/<YYYY-MM-DD>/ [MANUAL] 手动导出分类：书签点击记录，按导出日期分组。
```

### 数据与隐私
- **默认本地存储**：核心记录与推荐状态保存在浏览器本地存储（无独立后端服务）。
- **可选 GitHub 云端同步**：支持将数据与文档上传/下载到你个人的 GitHub 仓库。
- 插件会请求书签、历史记录、标签页等权限以提供完整功能。
- favicon 可能通过浏览器内置 favicon 服务或公共 favicon 源加载，并持久化到本地缓存。
- 更多详情请参考：[隐私政策 (`PRIVACY_POLICY.md`)](PRIVACY_POLICY.md)



## English

### Overview
`Bookmark Record and Recommend` is an enhanced extension for power bookmark users. It reawakens your knowledge base through three core engines: "Bookmark Records", "Smart Recommendations", and "AI Push".
It uses an S-Score algorithm for dynamic recommendations and processes all complex data computations locally. The "raw data + computed results" can be downloaded locally or synced to GitHub, allowing AI to perform deep analysis out-of-the-box using `AGENTS.md` / `CLAUDE.md` rules, bypassing the heavy raw computation burden.

It is also an ecosystem-related project for [Bookmark-Canvas](https://github.com/Browser-bookmark-hub/Bookmark-Canvas), with exported JSON files compatible with Bookmark Canvas import formats for tags and notes.

### Roadmap
- [ ] **More languages**: the current UI was mainly built around Chinese and English. Traditional Chinese, French, Russian, Spanish, Arabic, Japanese, Korean, and other languages are welcome as community contributions. See [`../docs/LIMITATIONS_AND_COMPROMISES.md#4`](../docs/LIMITATIONS_AND_COMPROMISES.md#4-语言切换与新增语言需要重构或共建).
- [ ] **Documentation co-building**: contributions are welcome for `AGENTS.md` / `CLAUDE.md` rule files, so different AI clients can better understand sync packages, output formats, and analysis boundaries. See [`AGENTS_template`](history_html/AGENTS_template/).
- [ ] **Ecosystem and data processing**: continue exploring Bookmark Canvas integration, recommendation packages, AI analysis results, CLI tools for data processing, and local knowledge-base / RAG directions; this is still exploratory.
- [ ] **Browser platform limitations tracking**: continue tracking browser API changes, platform capability boundaries, and browser bug fixes. See [`../docs/LIMITATIONS_AND_COMPROMISES.md`](../docs/LIMITATIONS_AND_COMPROMISES.md).

### Docs
- [`../docs/PROJECT_STRUCTURE.md`](../docs/PROJECT_STRUCTURE.md): current project structure and module map
- [`../docs/S_SCORE_ALGORITHM_V6_4.md`](../docs/S_SCORE_ALGORITHM_V6_4.md): current S-score v6.4, maintained buckets, and push structure
- [`../docs/LIMITATIONS_AND_COMPROMISES.md`](../docs/LIMITATIONS_AND_COMPROMISES.md): limitations and implementation compromises
- [`../docs/归档/00--归档索引-请先读.md`](../docs/%E5%BD%92%E6%A1%A3/00--%E5%BD%92%E6%A1%A3%E7%B4%A2%E5%BC%95-%E8%AF%B7%E5%85%88%E8%AF%BB.md): historical archive index and deletion candidates

### Changelog
> [!NOTE]
> #### v0.4.5
> - **Persistent browsing-history upgrade**: the browsing-record path moved from direct History API reads to local persistent caches and maintenance buckets, allowing click history to go beyond the previous roughly 90-day window; sync, deletion, migration, and repair logic were rebuilt around that.
> - **Export ecosystem and Bookmark Canvas compatibility**: exports now cover click rankings, related records, active tracking, time rankings, review queues, and add-to-review flows; JSON exports include tag/note semantics and temporary-section structures for [Bookmark-Canvas](https://github.com/Browser-bookmark-hub/Bookmark-Canvas).
> - **Default shortcut changes**:
>   - `Ctrl/Command+Shift+6`: activate the extension.
>   - `Ctrl/Command+Shift+7`: open the recommendation view.
>   - `Ctrl/Command+Shift+8`: open the records view.
>   - `Ctrl/Command+Shift+9`: quick review the next card.
> - **UX and performance fixes**: related records now use a lighter sliding/lazy window to reduce jank on large datasets; smaller fixes also cover widget UI, hardware acceleration, favicon deletion, and folded-queue cleanup.

### Core Algorithms
Most views, filters, and exports can be rebuilt from the raw bookmark tree, browsing history, plus data processing or AI analysis. The three sections below are the plugin's real core: Bookmark Recommendation S-Score, Active-Time Tracking, and the Local Browsing-History Library. Replacing them would still require substantial state maintenance and algorithm code. The code blocks are core examples extracted from the current implementation; full logic lives in the linked modules.

#### Bookmark Recommendation S-Score
Full implementation: [`background.js`](background.js).

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
Full implementation: [`active_time_tracker/index.js`](active_time_tracker/index.js).

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
Full implementation: [`background.js`](background.js) and [`browsing_history_calendar.js`](history_html/browsing_history_calendar.js).

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

### Preview

#### Push & Analyze Structure Preview
`Base Path` can be configured in Push & Analysis GitHub settings and is empty by default; when set, the whole structure lives under `<Base Path>/Bookmark Record and Recommend/`. If the path does not exist, the first push creates it by writing files under that path.
Generated by [`history_html/history.js`](history_html/history.js).
```text
Bookmark Record and Recommend/
|-- AGENTS.md                             [PUSH] Required Sync/AI rule document in the product folder under Base Path: manifest, pushId grouping, output format, and citation rules.
|-- data/manifest.json                    [PUSH] AI entry index: pushId, package files, hashes, read order; no package body or local delta summary.
|-- data/packages/bookmark-record.json    [PUSH] Bookmark record bundle: additions, clicks, rankings, related records, current time rankings and blocked state.
|-- data/packages/bookmark-recommend.json [PUSH] Bookmark recommendation bundle: S-scores, candidates, mode, review/block/skip/flip events.
|-- data/raw-native/bookmarks-tree.json   [PUSH] Bookmark-tree fact source: Phase A marks source and flattened-records format.
|-- data/raw-native/history-visits.jsonl  [PUSH] History fact source: JSONL rows; manifest records limit and truncated.
|-- ai/input-docs/index.json              [PUSH] Input-doc index in the View panel: file names and update timestamps.
|-- ai/input-docs/*.md                    [PULL/PUSH] Input task docs maintained in View; local/cloud deletes sync through push or pull.
|-- ai/results/**/*.md                    [PULL/PUSH] AI result docs: pulled for viewing; local edits, renames, and deletes sync on the next push.
|-- GitHub /commits?sha=<branch>          [READ] Commit timeline for the repository and change frequency.
|-- GitHub /compare/<base>...<head>       [READ] Diff summary after grouping commits by pushId; no local delta summary is generated.
|-- meta/sync_state.json                  [PUSH] Sync metadata: last push time, branch, pushed file count, doc count.
\-- manual-export/                        [MANUAL] Manual export folder: written only when an export panel chooses GitHub; normal push or pull ignores this folder. Categories are listed below.
    |-- click-ranking/<YYYY-MM-DD>/       [MANUAL] Manual export category: Click Ranking, grouped by export date.
    |-- current-tracking/<YYYY-MM-DD>/    [MANUAL] Manual export category: Current Tracking, grouped by export date.
    |-- time-ranking/<YYYY-MM-DD>/        [MANUAL] Manual export category: Time Ranking, grouped by export date.
    |-- related-history/<YYYY-MM-DD>/     [MANUAL] Manual export category: Related History, grouped by export date.
    |-- postponed-review/<YYYY-MM-DD>/    [MANUAL] Manual export category: Review Queue, grouped by export date.
    |-- bookmark-status/<YYYY-MM-DD>/     [MANUAL] Manual export category: Bookmark Status, grouped by export date.
    |-- bookmark-addition-records/<YYYY-MM-DD>/ [MANUAL] Manual export category: Bookmark Addition Records, grouped by export date.
    \-- bookmark-click-records/<YYYY-MM-DD>/ [MANUAL] Manual export category: Bookmark Click Records, grouped by export date.
```

### Data & Privacy
- **Local Storage by Default**: Core states are stored locally in browser storage (no dedicated backend service).
- **Optional GitHub Cloud Sync**: Supports uploading/downloading your data and documents to your personal GitHub repository.
- Permissions include bookmarks/history/tabs to support full functionality.
- Favicons may be loaded from the browser's built-in favicon service or public favicon providers, then persisted in local cache.
- For more details, please refer to our [Privacy Policy (`PRIVACY_POLICY.md`)](PRIVACY_POLICY.md)



---

## License

GPL-3.0

## [Back to top ](#switch-to-english)
