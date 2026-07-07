# AI 同步推送：时间范围过滤计划

## 概述

在推送区域新增时间范围选择按钮组，允许用户选择推送数据的时间范围。
默认值：**本月**。

### 时间范围选项

| 选项 | 英文 | 计算方式 |
|------|------|----------|
| 今天 | Today | 当天 00:00:00 起 |
| 本周 | This Week | 本周一 00:00:00 起 |
| 本月 | This Month | 本月 1 日 00:00:00 起（**默认**） |
| 本季度 | This Quarter | 当前季度第一天 00:00:00 起 |
| 本年 | This Year | 1 月 1 日 00:00:00 起 |
| 全部 | All | startTime = 0（无限制） |

---

## 三个数据包的时间特性分析

### 包 1：书签推荐包

#### recommendPool（推荐数据池）— ❌ 不过滤

| 字段 | 时间属性 | 是否过滤 | 原因 |
|------|----------|----------|------|
| recommend_scores_cache | 无（当前状态快照） | ❌ | 推荐分数是全量状态，不是时间序列 |
| scoreCacheMeta | recommendScoresTime（计算时间） | ❌ | 元数据，只标注最后计算时间 |
| historyCurrentCards | 无（当前卡组状态） | ❌ | 当前卡组快照 |
| bb_recommend_pool_cursor_v1 | 无 | ❌ | 池游标状态 |
| recommendFormulaConfig | 无 | ❌ | 配置 |
| recommendSectionOrder | 无 | ❌ | 配置 |
| recommendRefreshSettings | 无 | ❌ | 配置 |
| recommendMode | lastSwitchAt | ❌ | 模式状态 |

**结论**：recommendPool 是当前状态的快照，推荐分数没有时间维度，不受时间范围影响。

#### recommendEvents（推荐行为事件）— ✅ 部分过滤

| 字段 | 时间属性 | 是否过滤 | 说明 |
|------|----------|----------|------|
| flipHistory | `timestamp` | ✅ | 每条翻卡记录有 timestamp，按时间范围截断 |
| flipHistoryDailyIndexV1 | dateKey（日期键） | ✅ | 按日期键过滤 |
| recommend_reviews | 每个 review 内含 action 时间 | ✅ | 只保留时间范围内有操作的 review |
| recommend_postponed | `updatedAt` / `createdAt` / `addedAt` | ✅ | 按时间过滤 |
| recommend_blocked | 内含 `blockedAt` 等 | ✅ | 按时间过滤 |
| recommend_reviews_similar | 衍生自 reviews | ✅ | 跟随 reviews 自动缩小 |
| flippedBookmarks | 无（仅 ID 列表） | ❌ | 无时间戳 |
| recommend_skipped_bookmarks_v1 | 无（仅 ID 列表） | ❌ | 无时间戳 |

### 包 2：书签记录包

#### bookmarkRecords（书签记录）— ✅ 主要过滤目标

| 字段 | 时间属性 | 是否过滤 | 说明 |
|------|----------|----------|------|
| additionsRecords | `dateAdded` | ✅ | 只推送时间范围内新增的书签 |
| clickRecords（browsingRows） | `visitTime` / dateKey | ✅ | **核心过滤对象**：只推送时间范围内的浏览历史 |
| clickRanking | 衍生自 clickRecords | ✅ | 从过滤后的 clickRecords 重新计算排行 |
| relatedRecords | 衍生自 clickRecords | ✅ | 从过滤后的 clickRecords 重新衍生 |

#### timeTracking（时间捕捉）— ✅ 过滤

| 字段 | 时间属性 | 是否过滤 | 说明 |
|------|----------|----------|------|
| rankings | API 支持 startTime/endTime | ✅ | 传入时间范围的 startTime |
| trackingBlocked | 无 | ❌ | 屏蔽列表是配置 |

### 包 3：原生真相源包

#### bookmarkTreeSnapshot（书签树快照）— 部分过滤

| 字段 | 时间属性 | 是否过滤 | 说明 |
|------|----------|----------|------|
| 书签树 records | `dateAdded` | ❌ | 书签树是**当前结构快照**，不按时间过滤（AI 需要看全貌） |
| historyVisits（rawNative） | `visitTime` / dateKey | ✅ | 与 clickRecords 共享数据，统一过滤 |

---

## 实现计划

### Step 1：UI — 时间范围按钮组

- **位置**：推送数据包（三个勾选项）下方，状态栏上方
- **样式**：与浏览排行/关联记录的时间按钮组风格一致（pill 按钮组）
- **选项**：今天 / 本周 / 本月 / 本季度 / 本年 / 全部
- **默认**：本月
- **持久化**：`syncPushTimeRange` 存入 localStorage

### Step 2：核心过滤函数

```js
// 计算时间范围的 startTime
function getSyncPushTimeRangeStart(range) {
    const now = new Date();
    switch (range) {
        case 'day':    // 今天 00:00
        case 'week':   // 本周一 00:00
        case 'month':  // 本月1日 00:00
        case 'quarter':// 本季度第一天 00:00
        case 'year':   // 1月1日 00:00
        case 'all':    // return 0
    }
}
```

### Step 3：改造 collectSyncPushPayload

在 `collectSyncPushPayload` 中读取当前选中的时间范围，传入 startTime：

1. **浏览历史 API 扫描**：将 `effectiveStartTime` 设为选中范围的起始时间
2. **flipHistory**：过滤 `timestamp >= startTime`
3. **flipHistoryDailyIndex**：过滤 dateKey >= startDate
4. **recommend_reviews**：过滤有效 action 在时间范围内的
5. **recommend_postponed**：过滤 `updatedAt >= startTime`
6. **recommend_blocked**：过滤 `blockedAt >= startTime`
7. **additionsRecords**：过滤 `dateAdded >= startTime`
8. **clickRanking**：从过滤后的 rows 重新计算
9. **relatedRecords**：从过滤后的 rows 重新衍生
10. **timeTracking rankings**：API 调用时传入 `startTime`
11. **rawNative historyVisits**：与 clickRecords 共享过滤后的 rows

### Step 4：payload 元数据

在 payload 顶层注入时间范围元数据：

```json
{
    "schema": "bookmark_record_and_recommend.ai-push.v3",
    "generatedAt": 1234567890,
    "timeRange": {
        "range": "month",
        "startTime": 1234567890,
        "startTimeText": "2026-05-01",
        "endTime": 1234567890,
        "label": { "zh_CN": "本月", "en": "This Month" }
    },
    "packages": { ... }
}
```

### Step 5：i18n 支持

新增 i18n 条目：

| key | zh_CN | en |
|-----|-------|-----|
| syncPushTimeRangeLabel | 推送范围 | Push Range |
| syncPushTimeRangeDay | 今天 | Today |
| syncPushTimeRangeWeek | 本周 | This Week |
| syncPushTimeRangeMonth | 本月 | This Month |
| syncPushTimeRangeQuarter | 本季度 | This Quarter |
| syncPushTimeRangeYear | 本年 | This Year |
| syncPushTimeRangeAll | 全部 | All |

---

## 不过滤的数据（全量推送）

以下数据无论选什么时间范围都全量推送：

- recommendPool（推荐分数池 / 当前状态）
- flippedBookmarks（已翻卡 ID 列表）
- recommend_skipped（已跳过 ID 列表）
- 书签树快照（当前结构）
- trackingBlocked（屏蔽配置）
- 所有配置类数据
