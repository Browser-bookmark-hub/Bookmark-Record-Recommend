// Set initial view early without inline script (CSP-safe)
(function () {
  try {
    const params = new URLSearchParams(location.search);
    const sidePanelFlag = params.get('sidepanel') || params.get('side_panel') || params.get('panel');
    const isSidePanelMode = sidePanelFlag === '1' || sidePanelFlag === 'true';
    const viewStorageKey = isSidePanelMode ? 'lastActiveView__sidepanel' : 'lastActiveView';

    let view = params.get('view');
    let defaultView = 'widgets';
    if (Array.isArray(window.__ALLOWED_VIEWS) && window.__ALLOWED_VIEWS.length) {
      defaultView = window.__ALLOWED_VIEWS[0];
    }
    if (typeof window.__DEFAULT_VIEW === 'string' && window.__DEFAULT_VIEW) {
      defaultView = window.__DEFAULT_VIEW;
    }
    if (!view) {
      view = localStorage.getItem(viewStorageKey) || defaultView;
    }
    if (document?.documentElement) {
      document.documentElement.setAttribute('data-initial-view', view);
    }
    window.currentView = view;
  } catch (_) { }
})();
