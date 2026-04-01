# Quick Review Mode Plan (Backend-Capable)

## 1. Goal
Implement a lightweight quick-review flow that works even when neither side panel nor `history.html` is open.

## 2. Product Rules
1. Only one command in v1: `quick_review_next`.
2. No `previous` command.
3. Behavior is "simulate card click":
- open next card
- mark reviewed
- when current 3-card round is finished, auto-refresh to next round

## 3. Backend Ownership
Quick review execution must run in `background.js`:
1. command routing (`chrome.commands.onCommand`)
2. current round candidate selection (Top3 from S-score pool + postponed/blocked/skipped filters)
3. open-mode handling (`single_tab` / `new_tab`)
4. review state mutation (`flipped`, `review`, `historyCurrentCards`)

## 4. UI Responsibility
UI only triggers and displays:
1. header / widget / recommend panel buttons call background action.
2. settings panel edits quick-review open mode and writes to shared storage.
3. card rendering reads `historyCurrentCards` (storage sync) and refreshes view.

## 5. Data Compatibility
1. Continue using existing S-score cache and recommend pool cursor in background.
2. Continue using existing storage keys:
- `historyCurrentCards`
- `flippedBookmarks`
- `recommend_skipped_bookmarks_v1`
- `recommend_postponed`
- `recommend_blocked`
- `quickReviewOpenMode`
- `quickReviewTabId`

## 6. Shortcut Constraint
Keep only one quick-review command with suggested key:
1. Windows/Linux: `Ctrl+Down`
2. macOS: `Alt+Down`

## 7. Acceptance Criteria
1. Pressing shortcut works with no side panel/page open.
2. Each trigger opens one target URL and records one review.
3. After 3 cards are reviewed, next round is refreshed automatically.
4. Opening UI afterward shows consistent current cards and flipped state.
