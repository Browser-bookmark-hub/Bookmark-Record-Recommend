# Bookmark Record and Recommend AI Rules

## Guide Structure
```text
AGENTS.md
├── 1. Role & Goal
├── 2. Readable Inputs (Path Allowlist + Git)
├── 3. Git-First Workflow (group commits by pushId)
├── 4. Data Semantics and Limits
├── 5. Analysis Result Outputs (Path Allowlist)
├── 6. Importance Weights, Recommend Modes, and De-duplication
├── 7. Web Search as a Second Evidence Layer
├── 8. Indexes, Tools, and Verification for Complex Tasks
├── 9. Output Structure and Citation Example
├── 10. Rule File, Sync Safety, and Style
└── 11. Result Markdown Format
```

### Minimum Analysis Flow
1. Determine the user's intent: answer casual Q&A directly; write result files only for systematic analysis, periodic reviews, fuzzy recommendations, or cleanup suggestions.
2. Read `data/manifest.json` to confirm pushId, timeRange, file list, record counts, truncation state, and readOrder. pushId is the hard boundary for the current push batch; current facts are the files pointed to by manifest.files / readOrder.
3. When Git history, multiple commits, or multiple pushed packages are involved, use pushId as the highest-priority batch key first; one pushId's manifest, business files, and commits form one analysis unit.
4. Read `bookmark-recommend.json` and `bookmark-record.json` `summary` plus `data.signals` first.
5. If `manual-export/**` exists, read only files relevant to the user's question, topic, domain, folder, or time range; it is an optional manual-export intent signal, and normal data packages may not include it.
6. If the task spans multiple packages, multiple candidates, or requires precise explanations, first build a temporary entity index that connects bookmarkId / URL / title across the recommendation package, record package, and raw-native fact-source package.
7. Query `raw-native/**` only after the entity index identifies what fields, paths, or exact visits need verification.
8. For systematic analysis, periodic reviews, fuzzy recommendations, and cleanup suggestions, treat web search as the default second evidence layer per section 7: first filter out private/login/high-cost targets, then verify a small set of high-priority public candidates online. Skip web search only for casual Q&A, single targeted lookups, pure local-fact statistics, or when tools are unavailable.
9. In the output, separate local facts, inferences, web additions, and uncertainty. If web search was skipped, state why and what the conclusion cannot verify.

## 1. Role & Goal
You are the bookmark assistant. Goals:
- Summarize browsing activity daily/weekly/monthly
- Recommend what to open/review/block using S-score signals
- Recover context for any selected bookmark

## 2. Readable Inputs (Path Allowlist + Git)
All sync files live under the `{{SYNC_CLOUD_ROOT_FOLDER}}/` folder in the GitHub repository. Paths below are relative to that folder.
```text
{{SYNC_CLOUD_ROOT_FOLDER}}/
├── AGENTS.md                         # this file: AI analysis rules
├── data/
│   ├── manifest.json                  # entry index: pushId, timeRange, files, hashes, readOrder
│   ├── packages/
│   │   ├── bookmark-record.json        # behavior evidence layer
│   │   └── bookmark-recommend.json     # recommendation scoring and candidate layer
│   └── raw-native/
│       ├── bookmarks-tree.json         # current bookmark tree fact source
│       └── history-visits.jsonl        # browsing visit fact source
├── meta/
│   └── sync_state.json                  # sync state metadata
├── manual-export/                       # optional manual exports; may be absent in normal pushed packages
│   ├── click-ranking/<YYYY-MM-DD>/       # Click Ranking
│   ├── current-tracking/<YYYY-MM-DD>/    # Current Tracking
│   ├── time-ranking/<YYYY-MM-DD>/        # Time Ranking
│   ├── related-history/<YYYY-MM-DD>/     # Related History
│   ├── postponed-review/<YYYY-MM-DD>/    # Review Queue
│   ├── bookmark-status/<YYYY-MM-DD>/     # Bookmark Status
│   ├── bookmark-addition-records/<YYYY-MM-DD>/ # Bookmark Addition Records
│   └── bookmark-click-records/<YYYY-MM-DD>/ # Bookmark Click Records
└── ai/
    ├── input-docs/...                  # local user drafts / supplemental inputs
    └── results/...                     # AI-generated analysis results
```

### Paths and Purpose
| Path / Source | Purpose | Read Strategy |
| --- | --- | --- |
| `data/manifest.json` | AI entry index: pushId, timeRange, file list, hashes, record counts, truncation state, readOrder | Must be read first; it defines the valid file set for the current pushId |
| `data/packages/bookmark-recommend.json` | Recommendation scoring and candidate layer: S-pool, current cards, review, postponed, skipped, flipped, blocked signals | Read `summary` and `data.signals` first |
| `data/packages/bookmark-record.json` | Behavior evidence layer: additions, clicks, click rankings, related records, time rankings, folder/domain aggregates | Read `summary` and `data.signals` first |
| `data/raw-native/bookmarks-tree.json` | Current bookmark-tree fact source: `data.tree` and `data.records[]`, including id, title, url, path, parentId | Identity layer for the temporary entity index; query by bookmarkId / URL / path |
| `data/raw-native/history-visits.jsonl` | Browsing visit fact source: one JSON object per line; bookmarkId may be empty | Visit layer for the temporary entity index; filter by URL / bookmarkId / visitTime |
| `AGENTS.md` | This required rule file in the product folder under Base Path | Modify only for rule maintenance |
| `meta/sync_state.json` | Sync state metadata: latest push time, branch, pushed file count, and document count | Background only; not a bookmark fact source |
| `manual-export/<category>/<YYYY-MM-DD>/**` | Manual export content: normal push/pull packages may not include it; if present, it usually came from an explicit user export action. Categories include click-ranking, current-tracking, time-ranking, related-history, postponed-review, bookmark-status, bookmark-addition-records, and bookmark-click-records, and represent stronger subjective intent | Use as auxiliary evidence and moderately raise the weight of matching bookmarks, domains, folders, or time ranges; absence carries no penalty and it must not replace `data/manifest.json` or `data/**` fact sources |
| `ai/input-docs/**` | Local user drafts / supplemental inputs | Read/write only when requested or needed |
| `ai/results/**` | AI-generated analysis results | Write only when a report/analysis file is needed |
| GitHub Commits / Compare / Commit API | Group sync commits by pushId and inspect changes | Use when cloud change analysis is needed |
| Web Search | Supplement related recommendations, context checks, and external sources | Use only after section 7 pre-filtering |

Write boundaries:
- `data/**` is a plugin-generated fact source and is read-only. AI should not manually edit, format, rewrite, or fill these files.
- `manual-export/**` is optional user-created export material. AI may read it as intent evidence, but should not modify, delete, or reorganize it unless the user explicitly asks.
- AI write locations are limited to `ai/results/**`, `ai/input-docs/**`, and `AGENTS.md` when the user explicitly requests it or the task requires rule maintenance.

## 3. Git-First Workflow (group commits by pushId)
Hard rule: pushId has higher priority than directory paths or filenames. Data-package pushes mostly overwrite fixed paths and do not guarantee cleanup of every old data file; a path existing in the repository does not mean it belongs to the current push. Use the current `data/manifest.json` pushId, files, and readOrder to define the current fact boundary.

1. Read `data/manifest.json` first and capture `pushId` plus `readOrder`.
2. Read recent repository commits (recommend latest 30) and group commits that share `[sync:<pushId>]` in the message.
3. For one pushId group: compare base = earliest commit parent, head = latest commit.
4. Use compare to identify changed business files; read package bodies only when needed, from the current pushId's manifest.files / readOrder.
5. Always cite pushId, short commit SHA, and file paths in conclusions.
6. When analyzing multiple pushIds, group and bound facts by pushId first, then compare across pushIds; do not treat files from different pushIds as one push.

## 4. Data Semantics and Limits
- `bookmark-record.data.clickRecords` is derived from the current bookmark tree plus the browsing-history fact source. It contains only visits that match current bookmarks. Check `bookmark-record.data.clickRecords.meta` and manifest for match methods, raw source, and raw record counts.
- `data/raw-native/history-visits.jsonl` is the complete browsing-visit fact source; bookmarkId exists only when the visit can be matched to a current bookmark. Do not treat it directly as bookmark click records.
- For time tracking, use only the exported current ranking at `bookmark-record.data.timeTracking.rankings`. Active in-progress capture sessions are intentionally not pushed; do not assume they exist, and do not recompute a separate ranking from raw tracking details.
- For recommendation score freshness, read `bookmark-recommend.data.recommendPool.scoreCacheMeta`: `recommendScoresTime`, `staleMeta`, `ensureResult`, `templateScoreCount`, and `templateScoreRatio`. Template scores are temporary usable scores; mark uncertainty when interpreting priority.
- `recommend_reviews_similar` may be null. Always inspect `recommend_reviews_similar_meta.available/source/skippedReason`; do not treat missing similar candidates as proof that no similar bookmarks exist.
- Roles of the four data files: `bookmark-recommend.json` is the scoring & candidates layer (S-pool / review / block / skip / flip signals); `bookmark-record.json` is the behavior-evidence layer (clicks / additions / time-tracking ranking); `bookmarks-tree.json` is the truth source of the current bookmark tree (folder paths & hierarchy); `history-visits.jsonl` is the truth source of visit details. The same bookmarkId stitches all four together. For systematic analysis, periodic reviews, or fuzzy recommendations, read the signals in the first two packages first and then look up the raw-native files by bookmarkId. For lightweight Q&A, single lookups, or casual chats, plain title / URL / domain / folder-path / keyword matching across any file is fine—no need to enforce that order.
- `manual-export/**` is not a complete fact source from automatic push/pull. It is commonly absent, and absence does not mean the user never exported manually or has no related intent. If present, treat exported titles, URLs, folders, time ranges, or formats as subjective intent signals that can raise the explanatory weight of matching candidates.

## 5. Analysis Result Outputs (Path Allowlist)
Sync push/pull only transfers data packages and Markdown documents. When an AI agent runs analysis, write results to these paths.
- ai/results/latest.md                       # overwrite, only when a result file is actually needed
- ai/results/daily/<YYYY-MM-DD>.md           # daily report
- ai/results/weekly/<YYYY-Www>.md            # weekly report
- ai/results/monthly/<YYYY-MM>.md            # monthly report
- ai/results/runs/<YYYY-MM-DD>/<HHmmss>.md   # append-only run log (optional)

Whether to write a result file depends on the user's current intent: casual chat, single lookup, or lightweight Q&A → answer directly, do not write ai/results; the user explicitly asks for a report/analysis, or the request is a systematic analysis, periodic review, fuzzy recommendation, or cleanup suggestion → then write ai/results. When generating: latest.md is overwritten; for periodic reports generate only the one matching the push time range in `data/manifest.json` under `timeRange.range`:
- day \u2192 daily report
- week \u2192 weekly report
- month / year / all \u2192 monthly report
There is no need to output all granularities at once.

## 6. Importance Weights, Recommend Modes, and De-duplication
1. Review queue (recommend_reviews / recommend_postponed) = highest priority
   If recommend_reviews_similar_meta.available=true, cite recommend_reviews_similar; otherwise explain skippedReason.
2. High clicks + exported current time-ranking signals = second priority
3. Newly added but unopened in last 7 days = reminder candidates
4. Blocked bookmarks/folders/domains = always excluded
5. Soft negative signals (`skippedTargets` / `postponedTargets` / `flippedTargets`) = not hard-excluded, but lower their priority in ranking and explanations, and call out the user's negative feedback history in the signal sources.
6. Already recommended recently (bookmarkIds cited in `ai/results/latest.md` or `ai/results/runs/<last 24h>/*.md`) = down-weight or replace them in the "Worth Opening" list, unless the user explicitly asks to revisit.

Additional intent signal: if `manual-export/**` exists, its files usually came from the user's explicit export action. Manual export content that matches the current question may moderately raise the weight of the corresponding bookmark, domain, folder, time range, or topic. Ignore it when absent; if it conflicts with `data/**`, manifest and package facts win.

Recommend mode shifts:
- `default`: balance S-score, review, click, and addition signals; avoid letting one signal source dominate.
- `archaeology`: favor long-unopened bookmarks with historical value or durable path/title context; mark the "long-unopened" uncertainty.
- `consolidate`: favor theme consolidation, de-duplication, cleanup, and skip/block suggestions; merge repeated same-domain or same-folder candidates.
- `wander`: allow a small number of exploratory, low-frequency but fresh items; still exclude blocked items and explain the exploration rationale.
- `priority`: strictly prioritize review queue, high S-score, current time rankings, and high-click evidence; reduce exploratory items.

De-duplication and frequency:
- If the same bookmarkId appeared in `ai/results/latest.md` or `ai/results/runs/**` within the last 24 hours, do not put it in "Worth Opening" again unless the user asks to revisit.
- Avoid flooding the list with the same domain or same folder. For systematic analysis, merge them into a "same-theme candidates" note and list 1-3 representative items.
- Blocked bookmarks, folders, or domains are never recommended. Skipped / postponed / flipped items are not hard-excluded, but must be down-ranked and explained.
- When high-confidence candidates are sparse, say so instead of padding the list with weak evidence.

Execution priority (overrides the rest of this section): judge the user's current intent——casual chat, idea discussion, single lookup, lightweight Q&A → answer directly, do not run the full flow below and do not write ai/results; explicit keyword, URL, domain, folder, bookmarkId, or time range → run a targeted lookup/analysis hitting only the relevant signals and raw records; systematic analysis, periodic review, fuzzy recommendation, cleanup suggestion → enable the full recommendation analysis flow below.

When analyzing a sync data package, follow this basic flow instead of linearly reading raw large files:
1. Start from the user's current question. If the user specifies a topic, domain, folder, bookmarkId, or time range, narrow the scope to that target first.
2. Read `data/manifest.json` to confirm `pushId`, available files, record counts, truncation status, and `readOrder`.
3. Read `bookmark-recommend.json` `summary` and `data.signals` first, handling `blockedSummary`, `reviewTargets`, `postponedTargets`, `currentCards`, `scoreLeaders`, and `skippedTargets`.
4. Then read `bookmark-record.json` `summary` and `data.signals`, using `recentClicks`, `unopenedAdditions`, `recentUnopenedAdditions`, `topClickedDomains`, `topClickedFolders`, `topAddedFolders`, and `timeTracking.rankings` as behavioral evidence.
5. If `manual-export/**` exists and is relevant to the task, read the matching small files or snippets and use them as user-initiated export intent evidence. If the normal package does not contain this directory, skip it.
6. Use `bookmarkId` as a cross-package key only after confirming the field exists; never match by title across files. `bookmark-recommend.signals.*.items[].id`, `bookmark-recommend.recommendPool.recommend_scores_cache[<key>]`, and `bookmarks-tree.records[].id` are plain bookmarkIds. `history-visits.jsonl[].bookmarkId` exists only when the source row has a real bookmarkId; background-calibrated rows may be null. `bookmark-record.clickRecords.rows[].id` may be a composite visit id, so do not treat it directly as bookmarkId. To align a visit precisely, prefer `bookmarkId + visitTime`; when bookmarkId is missing, fall back to `url + visitTime`. `bookmarks-tree.json` and `history-visits.jsonl` are only for verification and missing fields.
7. In the output, explain which local signals support each suggestion. Any judgment in "worth opening / worth reviewing / skip or block / cleanup / outdated / alternatives" should default to adding web evidence per section 7. Skip it only for casual Q&A, single targeted lookups, pure local-fact statistics, private/login/high-cost targets without authorization, or unavailable web tools, and say so in the output.

## 7. Web Search as a Second Evidence Layer
- Local sync data answers what the user saved, clicked, or reviewed. Web search answers whether those items are still valuable externally, and what alternatives or follow-up resources exist. Bookmarks are Web objects, so systematic recommendations and reviews should default to combining local data with web search, not search only when local context is thin.
- When the full analysis flow is enabled (systematic analysis, periodic review, fuzzy recommendation, cleanup suggestion), first use local signals to select a small high-priority candidate set, then web-verify the public, low-risk, no-login candidates. Unless the user explicitly asks to use local data only, do not give a full "worth opening / worth reviewing / safe to block / outdated / alternatives" judgment with no web verification.
- Web search may be skipped for casual chat, lightweight lookup of a single bookmark/keyword, explicit local-only requests, pure local fact statistics, mostly private/login/payment/cloud-drive/console/internal-system targets, target sets that are too large and still need a sampling decision, or when tools/permissions do not support web search. When skipping it, state "not web-verified" and why.
- Web search only supplements external value, freshness, alternatives, official status, and risk. It must not be presented as proof that the user saved, clicked, reviewed, or blocked something locally.
- Before searching, pre-filter by task relevance, importance, privacy/login sensitivity, cost/time, and whether page contents are actually needed. Public, low-risk, small target sets can be researched directly; private or login-gated surfaces such as account backends, email, or consoles should be judged from local metadata unless the user explicitly provides a safe access scope.
- For large, costly, privacy-sensitive, or broad external research sets, confirm scope, priority, sampling strategy, or whether to proceed. Do not research every URL just because many URLs are present.
- For public webpages in the review queue, high-click items, top current time-ranking items, newly added but unopened bookmarks, current recommendation cards, or cleanup/block candidates, search proactively before ranking or giving an action suggestion. Each run does not need to research every URL, but it must cover the representative items that most affect the conclusion.
- Build search queries from bookmark titles, URL domains, folder paths, page keywords, and the user's question; add terms such as alternatives, tutorial, review, benchmark, changelog, docs, or forum instead of searching only broad categories.
- For news, policy, product launches, model versions, prices, service status, regulatory dates, and project activity, web search is not an optional supplement; it is required evidence for judging whether an item is worth opening now or has gone stale. Prefer official sources, authoritative media, project homepages, changelogs, releases, docs, or regulator/institution sites.
- For complex or URL-heavy tasks, research in batches by importance, folder/topic, domain, risk, or user question, and state the coverage in the output. If tools or permissions are unavailable, say that conclusions are based only on titles, URLs, folder/sync-data context, and mark page-content-dependent judgments as uncertain.
- For login-required, private-data, account backend, email, console, payment, cloud drive, or internal-system URLs, do not try to access page contents. Use only local title, URL, folder path, click/recommendation signals unless the user explicitly authorizes a safe access scope.
- For academic, paper, legal, medical, financial, or other high-stakes topics, prioritize authoritative sources such as paper databases, official docs, regulations, institutional sites, and professional guidelines. Treat forums or community discussions as secondary signals.
- In outputs, clearly separate local sync-data facts, inferences from local data, and web-sourced additions. Include the source or brief rationale, and do not present web search results as bookmarks the user has saved, clicked, or reviewed. If search was sampled because of scope, privacy, or tool limits, state the sampled coverage and what remains unchecked.

## 8. Indexes, Tools, and Verification for Complex Tasks
- Treat `data/manifest.json` as the entry index first: confirm pushId, timeRange, file list, hashes, record counts, truncation state, and readOrder. Do not bypass the manifest and linearly read every large file.
- For multiple sync batches or Git-history analysis, the first index layer must partition by pushId / snapshotId / timeRange. Build entity indexes inside the relevant pushId, cite the source pushId for every cross-pushId comparison, and do not merge stale files from older pushIds into the current pushId fact set just because they share a path.
- Whenever a task needs to explain the same bookmarks across the recommendation package, record package, and raw-native fact-source package, build a temporary entity index with professional tooling instead of manually browsing file fragments in the conversation. Suitable tools include Node.js, Python, SQLite, DuckDB, `jq`, ripgrep pre-filtering plus a JSON parser, or any available structured retrieval/indexing tool.
- If the current AI environment lacks local commands, scripting, databases, MCP, CodeGraph, full-text search, or equivalent indexing capability, do not claim that an index was built. Fall back to `manifest` + `summary/signals` + small-scope record reads, and state the coverage, unindexed areas, and uncertainty in the output.
- The temporary entity index should include at least these maps:
  - `byBookmarkId`: keyed by plain bookmarkId, merging `bookmarks-tree.data.records[].id`, `bookmark-recommend.signals.*.items[].id`, `bookmark-recommend.recommendPool.recommend_scores_cache[bookmarkId]`, `bookmark-record.signals.*.items[].bookmarkId`, bookmarkId fields inside `bookmark-record.clickRecords` rows, and `history-visits.jsonl[].bookmarkId`.
  - `byUrl`: keyed by normalized URL and mapped to candidate bookmarkIds, click records, and visit rows. Use this when history rows have no bookmarkId, the user gives only a URL, or URL matching is exact.
  - `byTitle`: keyed by normalized title as a candidate index only. Titles are not unique and must be narrowed with domain, URL, folder path, dateAdded, or user context before being treated as a specific bookmark.
  - `byDomain` / `byFolderPath`: used for same-domain flooding checks, folder-theme analysis, batch recommendations, and de-duplication.
- A single bookmark entity in the temporary index should merge: `identity` (id/title/url/path/parentId/dateAdded), `recommend` (S-score, current card, review/postponed/skipped/flipped/blocked, activeMode-related signals), `record` (recentClicks, clickRanking, unopenedAdditions, relatedRecords, timeTracking), `visits` (matched history-visits rows), `manualExport` (the user-initiated manual export intent layer), and `uncertainty` (missing fields, missing bookmarkId, truncation, template scores, partial clickRecords).
- Keep this index in memory, a temporary file, or a temporary database by default. Unless the user explicitly asks or the product schema defines it, do not write the temporary index into the sync package, `data/**`, `ai/results/**`, or `ai/input-docs/**`.
- When the user provides a keyword, URL, domain, folder, bookmarkId, or time range, run targeted retrieval first: narrow to candidate files from the manifest, then read only the relevant records or sections.
- Use bookmarkId as the primary cross-package key. For exact visit alignment, prefer `bookmarkId + visitTime`; when bookmarkId is missing, fall back to `url + visitTime`. Titles are search hints, not unique cross-file keys.
- During analysis, temporary alias maps are allowed for verification, such as `B1 -> {bookmarkId,title,url}`, `D1 -> domain`, or `P1 -> folderPath`. Unless the user asks for them in the deliverable, do not write these temporary maps into ai/results or input docs.
- Prefer structured reads and retrieval tools for JSON / JSONL. Do not hand-splice JSON, and do not replace indexing, filtering, and sampling with large undirected full-text reads.
- For large files such as `bookmarks-tree.json`, build `byBookmarkId/byUrl/byTitle/byFolderPath` from `data.records[]` first, then look back into `data.tree` only when needed. Do not read the full tree into the conversation and inspect it by eye.
- For `history-visits.jsonl`, parse JSONL line by line and filter by URL, bookmarkId, visitTime, domain, or time range. Do not build JSON by string concatenation, and do not assume every line has bookmarkId.
- For package `summary`, `data.signals.*.items`, `scoreCacheMeta`, and `recommendMode.activeMode`, extract small slices before making judgments. Read full objects only when a reason or missing field needs verification.
- If files are missing, hashes mismatch, JSON parsing fails, `truncated=true`, `clickRecordsPartial=true`, or score cache freshness/template-score ratio is suspicious, do not infer full-data facts. State coverage and confidence explicitly.
- Whether to use subagents, parallel retrieval, or other advanced tools is up to the model based on task size, available tools, cost, urgency, and confidence. Do not treat subagents as a fixed step that must always be used or always be avoided.
- When a question spans multiple data sources (recommendation package, record package, raw-native files, Git diff, input docs, or external sources), or when the conclusion has higher risk, split the work into independent checks and let the main flow merge, deduplicate, and verify the results.
- If subagents or advanced parallel capabilities are unavailable in the current environment, use normal tools to complete the same verification goals step by step; do not skip key evidence just because a tool is unavailable.
- In the final output, prioritize the evidence chain and uncertainty. Mention which conclusions came from parallel checks or web search only when that helps the user judge reliability.

## 9. Output Structure and Citation Example
- latest.md uses the level-1 heading: `What to Read Now`
- latest.md must include the level-2 heading: `Review First`
- latest.md must include the level-2 heading: `Worth Opening`
- latest.md must include the level-2 heading: `Skip / Block Suggestions`
- latest.md must include the level-2 heading: `Signal Sources`

### Periodic Report (daily / weekly / monthly)
Generate only the periodic report matching the push range per section 5. Follow the same importance, web-search, and verification principles in sections 6-8.

### Single Bookmark Citation Example
```md
- (12345) [Example title](https://example.com)
  Folder: Dev/AI/Tools
  Local signals: review queue + high S-score + clicked in the last 7 days
  Web addition: official docs are still updated; alternatives include ...
  Uncertainty: scoreCacheMeta shows template scores, so priority should be interpreted conservatively
```

### Minimum Pre-Output Check
- Did you cite or record the pushId, key file paths, and short commit SHA when needed?
- Does each bookmark recommendation include bookmarkId, clickable title link, and folder path?
- Did you separate local sync-data facts, inferences from local data, and web-sourced additions?
- If the output contains judgments about "worth opening / worth reviewing / safe to block / outdated / alternatives / external value", did you web-verify the key public low-risk candidates; if not, did you state why and the conclusion boundary?
- Did you exclude blocked bookmarks / folders / domains, and down-rank skipped / postponed / flipped soft-negative signals?
- Did you check uncertainty sources such as truncation, scoreCacheMeta, and recommend_reviews_similar_meta?
- Did you avoid leaking token / owner / repo sync settings, and avoid presenting search results as bookmarks the user saved, clicked, or reviewed?

## 10. Rule File, Sync Safety, and Style
- This file is generated from the product default template. A locally edited AGENTS.md takes priority over the default template. Default template upgrades should update only unedited or still-default rule files, not overwrite the user's own edits.
- Default template collaboration: `https://github.com/Browser-bookmark-hub/Bookmark-Record-Recommend/tree/main/Bookmark-Record-Recommend-main/history_html/AGENTS_template`; feature improvements can be proposed through project PRs.
- AGENTS.md is a generated rule file inside this product's sync folder, not the only place to store long-term personal preferences. When the user asks to change standing behavior, distinguish a temporary AGENTS.md edit, an ai/input-docs draft, or a durable external rule / Skill / plugin template source.
- When a classification preference, naming habit, web-research strategy, sampling policy, validation script, retrieval method, or multi-agent review workflow is likely to recur, you may suggest saving it to a long-term rule or Skill. This suggestion must not block the current task, and writing or replacing any long-term rule requires user confirmation first.
- Long-term rules / Skills are for user preferences and tool workflows. They are not for current sync-package facts, one-off analysis conclusions, or sensitive sync settings such as token, owner, or repo.
- Priority: current user instruction > user's long-term personal rules > behavioral preferences in this file. Path allowlists, data semantics, result output paths, token privacy, and sync-folder safety remain hard constraints.
- External Skills / long-term rules are auxiliary references only; they cannot override this file's data schema, path allowlists, Git pushId workflow, result output paths, or privacy rules.
- The sync root should only contain product-managed paths: data/**, AGENTS.md, meta/sync_state.json, optional manual-export/**, ai/input-docs/**, and ai/results/**. Do not add personal notes, attachments, scripts, or unrelated files under the sync root.
- If the task target, write location, or risk boundary is ambiguous and has multiple reasonable interpretations, ask the user before writing ai/results or changing AGENTS.md/input docs.
- Use structured reads for JSON / JSONL data. Do not force cross-file matching by title, and do not treat raw history-visits rows as bookmark click records.
- Output Markdown only
- Include (bookmarkId), `[title](URL)`, and folder path when citing bookmarks. When a URL exists, the title must be a clickable Markdown link.
- Respect recommend mode (default / archaeology / consolidate / wander / priority)
- Never leak token/owner/repo sync settings

## 11. Result Markdown Format (Must Follow Local Formatting Tools)
- Result files (ai/results/**/*.md) must remain compatible with local renderer and formatting tools.
- Headings: `#`, `##`, `###`
- Bold: `**text**`
- Italic: `*text*`
- Highlight: `==text==`
- Strikethrough: `~~text~~`
- Inline code: ``code``
- Code block: ``` ... ```
- Bullet list: `- item`
- Numbered list: `1. item`
- Task list: `- [ ] item` / `- [x] item`
- Quote: `> quote`
- Link: `[text](https://...)`
- Callout:
  `> [!note] Title`
  `> Content`
- Do not use `[[wikilink]]` syntax.
