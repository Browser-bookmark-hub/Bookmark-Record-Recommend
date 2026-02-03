// Set initial view early without inline script (CSP-safe)
(function () {
  try {
    const params = new URLSearchParams(location.search);
    let view = params.get('view');
    let defaultView = 'additions';
    if (Array.isArray(window.__ALLOWED_VIEWS) && window.__ALLOWED_VIEWS.length) {
      defaultView = window.__ALLOWED_VIEWS[0];
    }
    if (typeof window.__DEFAULT_VIEW === 'string' && window.__DEFAULT_VIEW) {
      defaultView = window.__DEFAULT_VIEW;
    }
    if (!view) {
      view = localStorage.getItem('lastActiveView') || defaultView;
    }
    if (document?.documentElement) {
      document.documentElement.setAttribute('data-initial-view', view);
    }
    window.currentView = view;
  } catch (_) { }
})();
