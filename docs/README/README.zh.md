## Switch to [English](../../README.md)...

[![Linux.do](https://img.shields.io/badge/Linux.do-Portfolio-FFD700?logo=discourse&logoColor=white)](https://linux.do/u/kk1/activity/portfolio)
[![GitHub Releases](https://img.shields.io/github/v/release/Browser-bookmark-hub/Bookmark-Record-Recommend?logo=github&logoColor=white&label=GitHub+Releases)](https://github.com/Browser-bookmark-hub/Bookmark-Record-Recommend/releases)
[![Microsoft Edge Add-ons](https://img.shields.io/badge/Edge_Add--ons-Available-0078D7?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/hdoajmdijappigkbiiefbhkfifbfoleb)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ehodmhbidnoegdodnceiepdekgeoggck?color=0F9D58&logo=googlechrome&logoColor=white&label=Chrome+Web+Store)](https://chromewebstore.google.com/detail/ehodmhbidnoegdodnceiepdekgeoggck)

### 简介
`书签记录与推荐` 是一款为重度用户打造的增强型扩展，通过“书签记录”、“智能推荐”与“AI 推送”三大核心引擎唤醒你的知识库。
它基于 S 值算法实现动态推荐，并在本地完成所有复杂的关联计算。“原始数据 + 计算结果”可直接下载到本地或推送到 GitHub，让 AI 结合 `AGENTS.md` / `CLAUDE.md` 规则“开箱即用”地进行深度分析，免去了处理生数据的算力负担。

它也是 [书签画布（Bookmark-Canvas）](https://github.com/Browser-bookmark-hub/Bookmark-Canvas) 生态的关联项目，[导出的 JSON 文件](../PUSH_AND_ANALYZE_STRUCTURE.md)兼容书签画布导入的临时栏目与备注格式。

### 预览

#### 截图预览
| 侧边栏 | 推荐公式 |
| :---: | :---: |
| <img src="../../Screenshots%20and%20icons/v0.3/侧边栏%20zh.png" width="400"> | <img src="../../Screenshots%20and%20icons/v0.3/推荐公式%20zh.png" width="400"> |
| **书签记录** | **推送与分析** |
| <img src="../../Screenshots%20and%20icons/v0.3/书签记录%20zh.png" width="400"> | <img src="../../Screenshots%20and%20icons/v0.3/推送与分析%20zh.png" width="400"> |
| **关联记录** | **添加到待复习** |
| <img src="../../Screenshots%20and%20icons/v0.4.5/关联记录zh.png" width="400"> | <img src="../../Screenshots%20and%20icons/v0.4.5/添加到待复习zh.png" width="400"> |

### 路线图
- [ ] **语言增加与调试**：当前主要围绕中英文实现，后续繁体中文、法语、俄语、西班牙语、阿拉伯语、日语、韩语等语言欢迎共建；README 翻译文档可以继续放在 [`docs/README/`](./)。限制说明见 [`LIMITATIONS_AND_COMPROMISES.md#4`](../LIMITATIONS_AND_COMPROMISES.md#4-语言切换与新增语言需要重构或共建)。
- [ ] **文档共建**：欢迎共建 `AGENTS.md` / `CLAUDE.md` 约束文件，让不同 AI 客户端更好理解同步包、输出格式和分析边界。模板入口见 [`AGENTS_template`](../../Bookmark-Record-Recommend-main/history_html/AGENTS_template/)。
- [ ] **生态与数据处理探索**：围绕书签画布、推荐数据包、AI 分析结果、面向数据处理的 CLI 工具，以及本地知识库 / RAG 方向继续探索，目前仍处于探索阶段。
- [ ] **浏览器平台限制持续关注**：持续跟进浏览器 API 变化、平台能力边界与浏览器自身 bug 修复，相关约束和取舍见 [`LIMITATIONS_AND_COMPROMISES.md`](../LIMITATIONS_AND_COMPROMISES.md)。

### 相关文档
- [`PROJECT_STRUCTURE.md`](../PROJECT_STRUCTURE.md)：当前项目结构与模块定位
- [`S_SCORE_ALGORITHM_V6_4.md`](../S_SCORE_ALGORITHM_V6_4.md)：当前 S 值算法 v6.4、维护桶与推送结构
- [`PUSH_AND_ANALYZE_STRUCTURE.md`](../PUSH_AND_ANALYZE_STRUCTURE.md)：推送与分析结构图预览
- [`LIMITATIONS_AND_COMPROMISES.md`](../LIMITATIONS_AND_COMPROMISES.md)：限制与实现妥协
- [`归档/00--归档索引-请先读.md`](../%E5%BD%92%E6%A1%A3/00--%E5%BD%92%E6%A1%A3%E7%B4%A2%E5%BC%95-%E8%AF%B7%E5%85%88%E8%AF%BB.md)：历史计划归档与删除候选

### 更新日志
> [!NOTE]
> #### v0.4.8
> - **导出生态增强**：推送与分析、手动导出均可选择 GitHub、本地或两者；GitHub 手动导出按 `manual-export/<类别>/<日期>/` 规范存放，且不参与常规同步或拉取。关联记录支持右键任意条目导出上下文、设置前后范围并保留橙色选中语义；点击排行新增单项导出。
> - **体验与文档整理**：推荐模式新增备份恢复与 S 值重算说明；favicon 预热限制为 150 个去重域名；补充书签事件 API 审计与多语言文档准备。

### 核心算法
大部分视图、筛选和导出都可以基于原始书签树、浏览记录，再加上数据处理或 AI 分析重建；下面三块才是插件真正的核心能力：书签推荐 S 值计算公式、时间追踪、浏览历史本地库。它们即使被替代，也需要重新实现大量状态维护和算法代码。代码块是从当前实现抽出的核心示例，完整逻辑见对应模块。

#### 书签推荐 S 值计算公式
完整实现见 [`background.js`](../../Bookmark-Record-Recommend-main/background.js)。

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
完整实现见 [`active_time_tracker/index.js`](../../Bookmark-Record-Recommend-main/active_time_tracker/index.js)。

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
完整实现见 [`background.js`](../../Bookmark-Record-Recommend-main/background.js) 与 [`browsing_history_calendar.js`](../../Bookmark-Record-Recommend-main/history_html/browsing_history_calendar.js)。

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

### 数据与隐私
- **默认本地存储**：核心记录与推荐状态保存在浏览器本地存储（无独立后端服务）。
- **可选 GitHub 云端同步**：支持将数据与文档上传/下载到你个人的 GitHub 仓库。
- 插件会请求书签、历史记录、标签页等权限以提供完整功能。
- favicon 可能通过浏览器内置 favicon 服务或公共 favicon 源加载，并持久化到本地缓存。
- 更多详情请参考：[隐私政策 (`PRIVACY_POLICY.md`)](../../Bookmark-Record-Recommend-main/PRIVACY_POLICY.md)

---

## License

GPL-3.0

## [返回顶部](#switch-to-english)
