# S 值算法 v6.4 当前结构

整理基准：2026-07-08  
代码版本依据：`background.js` 中 `SCORE_ALGO_VERSION = 6.4`

本文档描述 `f62a074f7f4d1b26eaaae85415b4cb4234718db0` 和 `6d4a7658bb41aea2d2d3c63445520ce92c6164e9` 之后的当前现状。前者将浏览历史链路重构为可突破浏览器热窗口限制的本地库，后者清理旧路径并修补书签浏览记录与推荐搜索相关路径。

## 两个维护桶

### 1. 当前书签树桶

权威来源是 Chrome `bookmarks.getTree()`。

同步和推送侧通过 `buildBookmarkTreeSnapshot()` 优先调用 `fetchSyncBookmarkTreeFromApi()`，产物是：

```text
data/raw-native/bookmarks-tree.json
schema: bookmark_record_and_recommend.bookmarks-tree.v1
format: chrome-bookmarks-tree+flattened-records
source: bookmarks_api
```

这个桶维护当前书签事实：

- `id` / `parentId`
- `title`
- `url`
- `dateAdded`
- `folderPath` / `path`
- `ancestorFolderIds`
- 原始 `tree` 和扁平 `records`

S 值计算时，后台每次全量计算会重新 `bookmarks.getTree()`，只把有 `url` 的节点作为候选，并把祖先文件夹 ID 写入每个候选。屏蔽文件夹时会同时检查 `parentId` 和 `ancestorFolderIds`。

### 2. 浏览历史维护桶

`f62a074f...` 之后，浏览历史不再只依赖页面当前渲染窗口。当前维护桶是本地浏览历史库：

```text
IndexedDB: BookmarkBrowsingHistoryCacheDB_v2
dbVersion: 1
store: records
meta store: meta
schemaVersion: 2
fallback storage key: bb_cache_browsing_history_v1
```

后台元数据包含：

- `lastSyncTime`
- `lastFullSyncTime`
- `lastIncrementalWriteTime`
- `lastPartialSyncTime`
- `lastAnyWriteTime`
- `schemaVersion`

后台维护策略：

- 首次进入当前库版本会清理旧缓存并执行 `history-library-v2-initial-seed`。
- 每日后台同步 alarm：`bb_history_background_sync_v1`。
- 失败/活跃跳过后的重试 alarm：`bb_history_background_sync_retry_v1`，延迟 15 分钟。
- 当本次推送选择 `bookmarkRecords` 或 `rawNative/bookmarkTreeSnapshot` 时，会先请求一次 `runBrowsingHistoryCalibration`，reason 为 `sync-push-before-collect`。
- 同步导出时按当前推送时间范围读取 `readHistoryCacheRange()`，不再依赖日历当前页面窗口。

推送产物是：

```text
data/raw-native/history-visits.jsonl
schema: bookmark_record_and_recommend.history-visits-jsonl.v1
scope: browsing_history
```

它是浏览访问事实源，不等同于“书签点击记录”。能匹配当前书签时才会带 `bookmarkId`。

## S 值缓存

主缓存：

```text
storage.local.recommend_scores_cache
storage.local.recommend_scores_time
storage.local.recommend_scores_cache_mode
storage.local.recommend_scores_algo_version
storage.local.recommendScoresStaleMeta
```

缓存模式：

- `full`：书签数不超过阈值时，缓存 `S/F/C/T/D/L/R` 和元数据。
- `compact`：书签数超过 `SCORE_CACHE_COMPACT_THRESHOLD = 8000` 时，只保留 `S` 加必要元数据。
- 新算法版本不一致时，`ensureScoreAlgoVersion()` 会清空推荐缓存并写入 `recommend_scores_algo_version = 6.4`。
- 首次大库冷启动（`existingCount === 0` 且候选数不少于 `SCORE_BOOTSTRAP_THRESHOLD = 1200`）会先实算最多 `SCORE_BOOTSTRAP_LIMIT = 600` 个较新的书签，标记 `bootstrap-partial`，再排队全量重算。
- 批量增量或 ensure-ready 一次涉及不少于 `SCORE_TEMPLATE_BATCH_THRESHOLD = 800` 个书签时，才会先写模板分：`S = 0.5`、`_template = true`，随后由 `queueTemplateScoreRefine()` 异步补算。

缓存项的元数据来自当前书签树，包括 `url`、`title`、`parentId`、`dateAdded`、`ancestorFolderIds`。因此 `recommend_scores_cache` 既是分数池，也是推荐选择阶段的轻量候选元信息池。

## 候选过滤

全量计算流程 `computeAllBookmarkScores()`：

1. 从当前书签树取所有 URL 书签。
2. 读取屏蔽配置：
   - `recommend_blocked.bookmarks`
   - `recommend_blocked.folders`
   - `recommend_blocked.domains`
3. 排除被屏蔽书签、屏蔽文件夹后代、屏蔽域名。
4. 读取公式配置、待复习、复习记录、浏览历史统计、活跃时间统计。
5. 对剩余书签计算 S 值并写入 `recommend_scores_cache`。

## 因子定义

当前默认公式配置：

```text
weights:
  freshness: 0.15
  coldness: 0.15
  shallowRead: 0.30
  forgetting: 0.20
  laterReview: 0.20

thresholds:
  freshness: 30
  coldness: 10
  shallowRead: 5
  forgetting: 14
```

通用归一函数是：

```text
decayed = 1 / (1 + (value / threshold)^0.7)
normal = 1 - decayed
inverse = decayed
```

### F freshness

来源：当前书签树的 `dateAdded`。

```text
daysSinceAdded = now - dateAdded
F = inverseDecay(daysSinceAdded, freshnessThreshold)
```

越新越高。

### C coldness

来源：浏览历史维护桶聚合后的 `visitCount`。

匹配顺序：

1. URL 规范化 key。
2. `title + domain` 兜底 key。

```text
C = inverseDecay(visitCount, coldnessThreshold)
```

访问越少越高。

### T shallowRead

来源：活跃时间桶 `trackingStats`，经 `getTrackingDataForScore()` 归一到：

- `byBookmarkId`
- `byUrl`
- `totalMs`
- `totalCount`

匹配顺序：

1. `bookmarkId`
2. URL 规范化 key

```text
compositeMinutes = totalCompositeMs / 60000
T = inverseDecay(compositeMinutes, shallowReadThreshold)
```

如果没有命中追踪记录，使用中性值 `0.5`。如果全局追踪还没有热身完成，`shallowRead` 权重会被置零，其余四项权重按比例重归一。

热身条件满足任一即可：

- `totalMs >= 30 分钟`
- `totalCount >= 30`

### D forgetting

来源：浏览历史维护桶聚合后的 `lastVisitTime`。

```text
daysSinceLastVisit = now - lastVisitTime
D = normalDecay(daysSinceLastVisit, forgettingThreshold)
```

越久未访问越高。若从未访问过，则使用 `max(daysSinceAdded, forgettingThreshold)` 作为 proxy，避免大量未访问书签固定在同一分值。

### L laterReview

来源：`recommend_postponed`。

只有 `manuallyAdded` 的待复习项给 `L = 1`，其他为 `0`。它表示用户显式提前标注过“稍后复习/重点”。

### R review multiplier

来源：`recommend_reviews`。

`R` 不是加权项，而是乘数：

```text
stabilityTable = [3, 7, 14, 30, 60]
stability = stabilityTable[min(reviewCount - 1, 4)]
needReview = 1 - 0.9 ^ (daysSinceReview / stability)
R = clamp(0.7 + 0.3 * needReview, 0.7, 1)
```

没有复习记录时 `R = 1`。有复习记录时，近期刚复习过会压低分数，随时间推移逐步回到 1。

## 最终公式

```text
basePriority = wF * F + wC * C + wT * T + wD * D + wL * L
S = clamp(basePriority * R, 0, 1)
```

如果追踪关闭或追踪未热身：

```text
wT = 0
wF/wC/wD/wL 按原占比重归一
```

S 值缓存必须可复现，不包含随机项；否则每次重算都会造成推荐卡片和数值漂移。

## 单项增量更新

`updateSingleBookmarkScore()` 用于单个书签更新：

1. 根据 bookmarkId 取当前书签节点。
2. 补算祖先文件夹 ID。
3. 对该 URL 执行一次小范围历史 backfill。
4. 从浏览历史库读取该书签相关历史统计。
5. 读取公式、活跃时间、待复习和复习记录。
6. 更新 `recommend_scores_cache[bookmarkId]`。

这保证新增/操作单个书签后不必总是全量重算。

## 推送时导出的内容

推送前 `collectSyncPushPayload()` 会先确保推荐分数可用：

```text
ensureRecommendScoresReadyForView('sync-push-before-collect')
```

推荐包最终写入：

```text
data/packages/bookmark-recommend.json
schema: bookmark_record_and_recommend.bookmark-recommend.v1
```

最终包结构是 `summary` + `data` + `sourcePackages`。`data` 中包含：

- `recommendPool.recommend_scores_cache`
- `recommendPool.scoreCacheMeta`
- `recommendPool.historyCurrentCards`
- `recommendPool.bb_recommend_pool_cursor_v1`
- `recommendPool.recommendFormulaConfig`
- `recommendPool.recommendSectionOrder`
- `recommendPool.recommendRefreshSettings`
- `recommendPool.recommendMode`
- `recommendEvents.recommend_reviews`
- `recommendEvents.recommend_reviews_similar`
- `recommendEvents.recommend_reviews_similar_meta`
- `recommendEvents.recommend_postponed`
- `recommendEvents.recommend_postponed_version_v1`
- `recommendEvents.recommend_blocked`
- `recommendEvents.recommend_skipped_bookmarks_v1`
- `recommendEvents.flippedBookmarks`
- `recommendEvents.flipHistory`
- `recommendEvents.flipHistoryDailyIndexV1`
- `signals.scoreLeaders`
- `signals.currentCards`
- `signals.reviewTargets`
- `signals.postponedTargets`
- `signals.skippedTargets`
- `signals.flippedTargets`
- `signals.blockedSummary`
- `signals.recentFlipEvents`

`scoreCacheMeta` 会标明：

- 分数总数、有效/无效数量。
- 元数据齐备比例。
- 模板分数量和比例。
- `recommend_scores_time`。
- stale 原因。
- 推送前 ensure 的结果。

记录包最终写入：

```text
data/packages/bookmark-record.json
schema: bookmark_record_and_recommend.bookmark-record.v1
```

它由当前书签树 + 浏览历史事实源派生 `clickRecords`，只保留能匹配当前书签的访问记录。匹配方式为：

- `exact_url`
- `title_domain`

同时导出：

- `data.additionsRecords`
- `data.clickRecords`
- `data.clickRanking`
- `data.relatedRecords`
- `data.signals.recentClicks`
- `data.signals.unopenedAdditions`
- `data.signals.recentUnopenedAdditions`
- `data.signals.topClickedDomains`
- `data.signals.topClickedFolders`
- `data.signals.topAddedFolders`
- `data.timeTracking.rankings`
- `data.timeTracking.trackingBlocked`

原生事实源另外写入：

```text
data/raw-native/bookmarks-tree.json
data/raw-native/history-visits.jsonl
```

分析时应优先读 `bookmark-recommend.json` 和 `bookmark-record.json` 的 summary/signals，再用 `bookmarkId` 回查 `bookmarks-tree.json` 与 `history-visits.jsonl`。`history-visits.jsonl` 的 `bookmarkId` 可能为空，不能假设每条历史记录都对应当前书签。

## 当前结论

6.4 的 S 值算法是“当前书签树 + 浏览历史维护桶 + 活跃时间 + 用户显式复习行为”的混合启发式评分：

- 书签树决定候选、元数据、路径和屏蔽继承。
- 浏览历史维护桶提供 `visitCount` 与 `lastVisitTime`，突破只看当前日历窗口/热历史窗口的限制。
- 活跃时间提供浅阅读信号，但未热身时不参与权重。
- 待复习和复习记录表达用户显式意图。
- 推送包不只导出 S 值，还导出分数健康度、当前卡片、行为事件、记录证据和原生事实源，供 AI 交叉验证。
