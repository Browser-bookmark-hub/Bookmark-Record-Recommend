# 基础 API 应用

整理时间：2026-07-14  
范围：书签基础事件 API、书签树读取方式、以及 `onChildrenReordered` 是否需要接入。

## 结论

当前项目主要使用 4 个常规书签事件：

- `chrome.bookmarks.onCreated`
- `chrome.bookmarks.onRemoved`
- `chrome.bookmarks.onChanged`
- `chrome.bookmarks.onMoved`

另外有 `onImportBegan` / `onImportEnded` 用于导入或批量变化保护，但它们不属于常规增删改移事件。

当前代码没有监听 `onChildrenReordered`。按现有业务看，暂不需要补这个事件。

## 当前监听位置

### 后台推荐链路

文件：`Bookmark-Record-Recommend-main/background.js`

用途：

- 新增书签后维护 URL 索引、推荐分数更新队列和浏览历史定向回填。
- 删除书签后清理推荐状态、URL 索引和待 prune 状态。
- 标题或 URL 改变后更新 URL 索引、favicon 缓存和分数更新队列。
- 移动书签后刷新推荐缓存里的父级/祖先文件夹元数据。
- 大量事件触发时进入 bulk guard，避免频繁重算。

当前监听：`onCreated` / `onRemoved` / `onChanged` / `onMoved` / `onImportBegan` / `onImportEnded`。

### 时间追踪链路

文件：`Bookmark-Record-Recommend-main/active_time_tracker/index.js`

用途：

- 维护用于 URL / 标题匹配的书签缓存。
- 书签变化后通过防抖重建匹配缓存。
- 删除书签时清理对应时间记录和活跃 session。

当前监听：`onCreated` / `onRemoved` / `onChanged` / `onMoved` / `onImportBegan` / `onImportEnded`。

### 前台页面链路

文件：`Bookmark-Record-Recommend-main/history_html/history.js`

用途：

- 维护前台 additions 缓存 `allBookmarks`。
- 刷新 widgets、Additions、搜索和派生视图状态。
- 书签变化时标记相关派生数据 stale。
- 大量变化时进入前台 bulk refresh，最后重新拉书签树。

当前监听：`onCreated` / `onRemoved` / `onChanged` / `onMoved` / `onImportBegan` / `onImportEnded`。

## 7 个事件逐项影响

这组 API 对插件的影响分三层：

- 后台推荐链路：影响最大，负责推荐分数、推荐状态、URL 索引、浏览历史定向回填。
- 时间追踪链路：维护“当前哪些 URL / title 是书签”的匹配缓存。
- 前台页面链路：维护打开页面里的 additions 缓存、widgets、搜索和派生视图 stale 状态。

| 事件 | 当前有没有用 | 对插件的实际影响 |
| --- | --- | --- |
| `onCreated` | 有 | 新书签进入推荐分数队列；加入后台 URL 索引；触发该 URL 的浏览历史定向回填；前台 additions 缓存增加；时间追踪重建书签匹配缓存。 |
| `onRemoved` | 有 | 后台移除 URL 索引；清理推荐状态、待复习/跳过/屏蔽等可能失效项；前台删除 additions 缓存和 favicon；时间追踪删除对应时间记录并结束活跃 session。 |
| `onChanged` | 有 | 标题或 URL 改动后更新后台 URL 索引、favicon、S 值；前台更新 additions 缓存；清理部分 T 值、搜索和派生缓存；时间追踪重建匹配缓存。 |
| `onMoved` | 有 | 后台刷新推荐缓存里的 `parentId` / `ancestorFolderIds` 元数据；前台更新 additions 缓存的 `parentId` 并标记派生数据 stale；时间追踪重建匹配缓存。跨文件夹移动有意义，同级顺序变化意义很小。 |
| `onChildrenReordered` | 没有 | 当前没有任何代码使用。对现有核心功能基本没影响，因为它只表示同父文件夹内 children 顺序变化。 |
| `onImportBegan` | 有 | 进入导入或批量保护状态，暂停逐条重算，避免大量书签事件把后台或前台拖慢。 |
| `onImportEnded` | 有 | 退出导入状态，统一做一次防抖/批量刷新或恢复任务。 |

后台推荐链路是最重要的一层：

- `onCreated`：`queueBookmarkScoreMutation()`、URL 索引、历史回填。
- `onRemoved`：`queueRemovedRecommendStatePrune()`、URL 索引清理。
- `onChanged`：URL 索引、favicon、分数更新。
- `onMoved`：`queueMovedScoreMetadataRefresh()`，主要刷新父级/祖先文件夹元数据。
- import 事件：进入/退出 bulk mode。

时间追踪链路不是算推荐，而是维护书签匹配缓存：

- 创建/修改/移动：防抖重建书签 URL / title 匹配缓存。
- 删除：删除对应时间记录、结束活跃 session，再重建缓存。
- import：导入期间不频繁 rebuild，结束后统一 rebuild。

前台页面链路影响打开中的 UI：

- additions 缓存 `allBookmarks`。
- widgets additions 数量。
- 搜索索引失效。
- 浏览关联、排行等派生数据 stale。
- favicon 前台缓存。
- 大量变化时前台 bulk refresh。

## `onChildrenReordered` 判断

`onChildrenReordered` 表示同一个父文件夹下的 children 顺序变化。例如浏览器书签管理器里的 `Sort by name`。

这种变化通常不改变：

- `bookmarkId`
- `url`
- `title`
- `dateAdded`
- `parentId`
- `path`
- `folderPath`
- `ancestorFolderIds`

所以它不影响当前项目的核心数据语义：

- 推荐分数不依赖同级 children 顺序。
- 时间追踪匹配不依赖同级 children 顺序。
- 推荐搜索主要使用 `title` / `url` / `S`。
- 书签添加搜索主要使用日期、标题和 URL。
- 文件夹路径、父级和祖先文件夹链不会因为同级排序变化。

状态卡片或同步差异中看到的“移动/变化”，更多是基于两次书签树快照对比得出的结果，不代表当前项目已经监听了 `onChildrenReordered`。

## 书签树读取方式

当前很多真正需要树结构的入口会直接读取浏览器书签树，而不是依赖实时事件维护同级顺序。

典型入口：

- 书签添加日历：`history_html/bookmark_calendar.js` 直接调用 `chrome.bookmarks.getTree()`。
- 浏览记录日历：`history_html/browsing_history_calendar.js` 会直接调用 `browserAPI.bookmarks.getTree()`。
- 同步 raw-native 书签树：`history_html/history.js` 在构建同步包时直接调用 `bookmarks.getTree()`。
- 后台推荐和阻塞相关逻辑：需要完整树时也会直接调用 `bookmarks.getTree()`。

因此，同级排序变化即使没有事件监听，下一次需要完整树时也会读取到浏览器当前状态。

## 对书签记录和书签添加记录的影响

书签记录/书签添加记录这两个日历不是靠这些 API 一条条写事件日志。

书签添加记录日历是：打开时 `getTree()`，按当前书签的 `dateAdded` 生成视图。

书签浏览记录日历是：从本地浏览历史库读访问记录，再用当前书签集合过滤出“书签相关访问”。

所以这些事件对日历的作用更多是：

- 更新前台缓存。
- 标记派生数据 stale。
- 必要时触发刷新。
- 不是实时精确重排每个日历格子。

这也是 `onChildrenReordered` 对两个日历价值很低的原因：同级排序不改变 `dateAdded`、URL、标题、路径或父级。

## `onMoved` 仍然需要保留

`onMoved` 和 `onChildrenReordered` 不能等价看待。

跨文件夹移动会改变：

- `parentId`
- `path`
- `folderPath`
- `ancestorFolderIds`

这些字段会影响：

- 文件夹路径展示。
- 文件夹聚合统计。
- 文件夹屏蔽判断。
- 待复习/屏蔽树相关选择。
- 同步信号中的 folder/path 信息。
- 推荐缓存里的父级和祖先文件夹元数据。

所以 `onMoved` 仍然是必要事件。

## 当前可接受的边界

当前不加 `onChildrenReordered` 是可以接受的：

- `Sort by name` 只影响同父级显示顺序。
- 项目核心记录、推荐、时间追踪、搜索匹配都不依赖这个顺序。
- 真正需要树形顺序的地方通常会实时 `getTree()`。

如果未来出现以下需求，再考虑接入 `onChildrenReordered`：

- 页面常驻显示一个实时书签树，并要求同级排序立即刷新。
- 同步状态卡片需要把同级排序变化作为独立事件类型展示。
- 本地持久化一份严格顺序一致的书签树缓存，并要求无刷新实时维护。

届时也不应触发推荐分数重算，而应只做轻量处理：

- 标记书签树缓存 stale。
- 清理或刷新前台 tree cache。
- 通过已有 bulk/debounce 机制合并刷新。

## 后续优先级

相比补 `onChildrenReordered`，更值得关注的是 `onMoved` 后的路径缓存准确性。

当前前台 `moveBookmarkInAdditionsCache()` 主要更新 `parentId`，不会完整重算 `path` / `ancestorFolderIds`。如果跨文件夹移动后马上使用依赖路径的前台缓存，可能短时间读到旧路径。

如果后续要优化，应优先让跨文件夹 `onMoved` 走轻量防抖树刷新，而不是为同级 reorder 增加单独业务链路。
