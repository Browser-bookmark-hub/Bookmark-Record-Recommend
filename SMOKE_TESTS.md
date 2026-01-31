# Smoke Tests (Chrome MV3)

## Load / Basics
- Load the extension in chrome://extensions with Developer Mode enabled.
- Click the toolbar icon and ensure popup renders without errors.
- Open the Additions view and Recommend view via popup buttons.

## Additions View
- Verify additions list loads (review tab).
- Switch to Browsing tab and confirm calendar renders.
- Switch to Tracking tab and confirm widget/actions render.
- Use search input and confirm results update.

## Recommend View
- Verify recommendation cards render.
- Open the Recommend page and confirm it loads.
- Refresh recommendations and confirm cards update.

## Active Time Tracking
- Visit a bookmarked page and keep it active.
- Confirm tracking data updates and is reflected in the UI.

## Favicon Cache (Local + Shared)
- Confirm recommendation cards show favicons.
- If `sharedFaviconHostId` is set, confirm favicon fetch uses shared host (no console errors).
