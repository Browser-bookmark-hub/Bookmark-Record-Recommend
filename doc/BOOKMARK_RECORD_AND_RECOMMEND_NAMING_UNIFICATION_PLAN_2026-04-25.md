# 书签记录与推荐：导出命名与同步路径统一执行记录

日期：2026-04-25

## 1. 当前结论

本次目标已经收敛为两类运行行为：

1. 普通手动导出的下载目录、文件名前缀、导出弹窗文案。
2. AI 同步的云端根目录、本地压缩包、zip 内部根目录、schema 命名空间、固定规则文件路径。

不做旧路径迁移，不做旧命名兼容，不保留旧规则文件名别名。原因是当前还没有进入生产版本。

最终命名：

```text
插件中文名：书签记录与推荐
插件英文名：Bookmark Record and Recommend

手动导出根目录：
书签记录与推荐
Bookmark Record and Recommend

手动导出子目录：
书签添加记录 / Bookmark Addition Records
书签点击记录 / Bookmark Click Records

AI 同步根目录：
bookmark_record_and_recommend_sync

固定规则文件：
bookmark_record_and_recommend_sync/AGENTS.md

AI 同步 schema：
bookmark_record_and_recommend.*
```

## 2. 普通手动导出覆盖范围

现有普通手动导出入口只有两个：

| 功能 | 文件 | 状态 |
|---|---|---|
| 书签添加记录 | `history_html/bookmark_calendar.js` | 已改目录、文件名前缀、tooltip |
| 书签点击记录 | `history_html/browsing_history_calendar.js` | 已改目录、文件名前缀、tooltip |

以下模块当前没有独立普通手动导出入口，本次不新增：

```text
点击排行
关联记录
时间排行
时间捕捉
书签推荐
```

它们继续通过 AI 同步包进入：

```text
bookmark_record_and_recommend_sync/data/packages/bookmark-record.json
bookmark_record_and_recommend_sync/data/packages/bookmark-recommend.json
```

## 3. 手动导出结果

中文环境：

```text
Downloads/
  书签记录与推荐/
    书签添加记录/
      书签添加记录_<范围>.html
      书签添加记录_上下文_<范围>.html
      书签添加记录_集合_<范围>.html
    书签点击记录/
      书签点击记录_<范围>.html
      书签点击记录_集合_<范围>.html
```

英文环境：

```text
Downloads/
  Bookmark Record and Recommend/
    Bookmark Addition Records/
      bookmark_addition_records_<scope>.html
      bookmark_addition_context_<scope>.html
      bookmark_addition_collection_<scope>.html
    Bookmark Click Records/
      bookmark_click_records_<scope>.html
      bookmark_click_collection_<scope>.html
```

说明：

- 中文文件名保留中文，方便用户直接看下载目录。
- 英文文件名使用小写 + 下划线。
- 范围后缀沿用当前年、月、周、日、勾选日期等逻辑。
- 书签点击记录当前没有 UI 暴露上下文导出入口，不新增功能。

## 4. AI 同步结果

云端根目录：

```text
bookmark_record_and_recommend_sync/
```

云端结构：

```text
bookmark_record_and_recommend_sync/
  AGENTS.md
  data/
    manifest.json
    packages/
      bookmark-record.json
      bookmark-recommend.json
    raw-native/
      bookmarks-tree.json
      history-visits.jsonl
  ai/
    input-docs/
      index.json
    results/
  meta/
    sync_state.json
```

本地压缩包：

```text
bookmark_record_and_recommend_sync_YYYYMMDD_HHMMSS.zip
```

zip 内部根目录：

```text
bookmark_record_and_recommend_sync/
```

固定规则文件：

```text
bookmark_record_and_recommend_sync/AGENTS.md
```

规则：

- 推送时只写 `AGENTS.md`。
- 拉取时只读 `AGENTS.md`。
- 不按用户自定义标题改文件名。
- 不识别其他规则文件名别名。
- 不做旧同步路径迁移。
- 不从旧同步路径读取。
- 不向旧同步路径写入。

## 5. 已修改文件

```text
history_html/bookmark_calendar.js
history_html/browsing_history_calendar.js
history_html/history.js
history_html/history.html
github-token-guide.html
doc/BOOKMARK_RECORD_AND_RECOMMEND_NAMING_UNIFICATION_PLAN_2026-04-25.md
```

核心修改点：

- `getCalendarExportRootFolder()`
- `getCalendarExportFolder()`
- `BookmarkCalendar.generateExportFilename(mode)`
- `getBrowsingExportRootFolder()`
- `getBrowsingExportFolder()`
- `BrowsingHistoryCalendar.generateExportFilename(mode)`
- `SYNC_GITHUB_DEFAULT_BASE_PATH`
- `buildSyncLocalSnapshotFileName()`
- `buildSyncLocalExportArchiveName()`
- `buildSyncRepoPaths()`
- `buildSyncExportFiles()`
- `pushSyncSnapshotToGitHub()`
- `pullSyncDocsFromGitHub()`
- 同步 schema 字符串
- 设置页 placeholder / hint
- GitHub Token 配置说明

## 6. 验证清单

需要通过：

```bash
node --check history_html/history.js
node --check history_html/bookmark_calendar.js
node --check history_html/browsing_history_calendar.js
git diff HEAD --check
```

运行代码中应满足：

- 旧手动导出根目录名无残留。
- 旧手动导出英文根目录名无残留。
- 旧 AI 同步路径无残留。
- 旧 AI 同步 schema 命名空间无残留。
- 旧本地同步压缩包前缀无残留。
- 旧规则文件名别名兼容无残留。
- `AGENTS.md` 只固定在同步根目录。

## 7. 仍然不改的内容

以下内容不属于本次命名统一范围：

```text
manifest.json / _locales 里的插件展示名
页面主导航展示名
storage key，例如 aiSyncConfig_v1
内部端口名
数据包文件名 bookmark-record.json、bookmark-recommend.json
给点击排行、关联记录、时间排行新增普通手动导出
```

原因：

- 展示名当前已经是 `书签记录与推荐 / Bookmark Record and Recommend`。
- storage key 和内部端口名不属于用户可见导出目录或同步根目录。
- 数据包文件名表达的是包类型，不是产品路径 slug。
- 点击排行、关联记录、时间排行当前没有普通手动导出入口。
