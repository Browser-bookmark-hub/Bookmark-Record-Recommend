# Bookmark Recommend Pools v6.3 Plan

本文档是 `v6.2` 的升级计划书。目标是解决“快速复习每换一轮都全量 `bookmarks.getTree()`”的问题。

## 0. 当前状态确认

- 当前算法版本：`6.2`
- 代码位置：`background.js` 中 `const SCORE_ALGO_VERSION = 6.2`

## 1. 问题定义（v6.2）

当前是“两层”：

1. `S` 计算层：`recommend_scores_cache`（持久化 + 增量更新）  
2. 选卡层：换轮时全量拉书签树，再与 `S`/屏蔽/延期/跳过/翻牌状态合并排序

结果：

- `S` 没有每轮重算，但“换轮”仍有全量遍历与全量排序成本。
- 三卡位场景下，这个成本不合理。

## 2. v6.3 目标

1. 快速复习换轮不再调用 `bookmarks.getTree()`。  
2. 继续保留 `S` 的增量更新机制。  
3. 不新建第二套复杂系统，直接扩展现有池子结构。  
4. 仅在“首次迁移 / 导入完成 / 数据损坏修复”时允许一次全量重建。

## 3. 数据模型升级（同池扩展）

沿用 `recommend_scores_cache`，但每个 `bookmarkId` 的值从“只含分值”扩为“分值 + 选卡元信息”。

建议结构：

```js
recommend_scores_cache[bookmarkId] = {
  S: 0.83,
  _template: false,
  url: "https://...",
  title: "...",
  dateAdded: 1710000000000,
  parentId: "123",
  ancestorFolderIds: ["1", "2", "123"],
  updatedAt: 1710000000000
}
```

保留现有游标键：

- `bb_recommend_pool_cursor_v1`

## 4. 核心流程改造

### 4.1 换轮选卡（核心改动）

`selectQuickReviewCardsRoundState` 改为：

1. 读 `recommend_scores_cache`（不拉树）  
2. 从缓存条目构建候选集合  
3. 合并 blocked / postponed / skipped / flipped / currentCards 过滤  
4. 按 `forceDue` + `S` + tie-break 排序  
5. 按 cursor 取 3 张并落 `historyCurrentCards`

### 4.2 增量维护（替代“每轮拉树”）

通过书签事件维护池子条目：

1. `onCreated`：新增条目（先模板或实时算 S），写入元信息  
2. `onChanged`：更新 url/title，并更新该条目 S  
3. `onRemoved`：删除条目 + 现有 prune 流程  
4. `onMoved`：更新 parent/ancestor（书签移动直接更新；文件夹移动时对子树一次性更新）

### 4.3 迁移与兜底

首次升级到 `6.3`：

1. 执行一次 `getTree` 迁移，补齐所有条目的元信息。  
2. 迁移完成后写 `SCORE_ALGO_VERSION = 6.3`。  
3. 之后换轮路径禁止再走 `getTree`。  
4. 若检测缓存损坏（关键字段缺失率过高），仅触发一次修复重建，不在每轮触发。

## 5. 兼容策略

1. 对旧缓存条目（仅 `{S}`）兼容读取。  
2. 选卡时发现条目缺元信息：先跳过该条并异步补齐，不阻塞本轮。  
3. 保证“旧用户可继续使用、逐步完成池子升级”。

## 6. 性能目标

1. 快速复习换轮：`0` 次 `bookmarks.getTree()`。  
2. 每轮复杂度从“全量遍历树 + 全量排序”下降为“缓存扫描 + 过滤 + 排序”。  
3. `getTree` 仅出现在：
  - 首次迁移
  - 导入后重建
  - 显式修复

## 7. 落地步骤（建议顺序）

1. `v6.3` 数据结构定义与读写兼容层。  
2. 书签事件增量维护元信息（create/change/remove/move）。  
3. 换轮选卡改为纯缓存路径（删除每轮 `getTree`）。  
4. 启动迁移任务（一次性补元信息）。  
5. 增加调试计数器与日志（验证换轮无 `getTree`）。  
6. 完成手测与回归。

## 8. 验收清单

1. 新装用户：首次初始化后换轮稳定，无自动“换批抖动”。  
2. 旧用户：升级后可用，不要求手动清缓存。  
3. 快速复习连续 30 次：换轮不触发 `getTree`。  
4. 书签增删改移后：推荐结果与 UI 卡片一致。  
5. 文件夹屏蔽 / 域名屏蔽 / 延期 / 跳过语义保持不变。

## 9. 风险与控制

1. 风险：缓存体积变大。  
控制：保留 compact/full 策略，必要时裁剪非关键字段。  

2. 风险：文件夹移动时祖先链失真。  
控制：`onMoved` 对文件夹子树做一次增量修正。  

3. 风险：迁移窗口内个别条目元信息缺失。  
控制：兼容读取 + 异步补齐 + 单次修复任务。
