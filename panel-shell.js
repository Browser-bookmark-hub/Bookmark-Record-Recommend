(function () {
  try {
    const frame = document.getElementById('sidePanelFrame');
    if (!frame) return;

    const params = new URLSearchParams(window.location.search || '');
    const requestedView = params.get('view');
    const safeView = requestedView === 'widgets' || requestedView === 'recommend' || requestedView === 'additions'
      ? requestedView
      : '';

    const query = new URLSearchParams();
    query.set('sidepanel', '1');
    if (safeView) {
      query.set('view', safeView);
    }

    frame.src = `history_html/history.html?${query.toString()}`;
  } catch (_) { }
})();
