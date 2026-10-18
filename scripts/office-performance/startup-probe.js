/** Issue #191 (parent #118): injected observer for the actual App landing page.
 * No UI/state changes or editor imports. The native host supplies configuration.
 */
(() => {
  'use strict';
  const config = window.__OFFICE_PERFORMANCE__;
  const scope = 'full application landing';
  const started = performance.now();
  const expiresAt = started + 10000;
  let stage = 'DOMContentLoaded';
  let frameId;
  let deadlineTimer;
  let removeDomListener = () => {};
  let stopped = false;
  let lastGeometry;
  const font = { status: document.fonts.status, waitStarted: null, readyAt: null };
  const errorText = error => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const navigation = () => performance.getEntriesByType('navigation').map(entry => entry.toJSON());
  const resources = () => performance.getEntriesByType('resource').map(entry => entry.toJSON());
  const heading = () => [...document.querySelectorAll('h1')].find(node => node.textContent.trim() === '打开你的 Workspace');
  const geometry = node => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!node.isConnected || !rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 ||
        rect.top >= innerHeight || rect.left >= innerWidth || style.display === 'none' ||
        style.visibility !== 'visible' || Number(style.opacity) === 0 || !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    const root = document.getElementById('root');
    if (!root || !root.contains(node)) return null;
    const box = root.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return { heading: [rect.x, rect.y, rect.width, rect.height], root: [box.x, box.y, box.width, box.height],
      viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY] };
  };
  const sameGeometry = (a, b) => a && b && Object.keys(a).every(key =>
    a[key].every((value, index) => Math.abs(value - b[key][index]) <= 0.5));
  const domReady = () => new Promise(resolve => {
    if (document.readyState !== 'loading') { resolve(); return; }
    const listener = () => { removeDomListener(); resolve(); };
    removeDomListener = () => document.removeEventListener('DOMContentLoaded', listener);
    document.addEventListener('DOMContentLoaded', listener, { once: true });
  });
  // The deadline rejects if a hidden native window suspends RAF. Timers never
  // stand in for a paint frame and document.hidden is retained as evidence.
  const nextFrame = () => new Promise(resolve => {
    frameId = requestAnimationFrame(timestamp => { frameId = undefined; resolve(timestamp); });
  });
  const observe = async () => {
    await domReady();
    if (stopped) return;
    stage = 'landing h1 visible';
    let node;
    while (!stopped) {
      node = heading();
      if (node && geometry(node)) break;
      await nextFrame();
    }
    if (stopped) return;
    stage = 'document.fonts.ready';
    font.waitStarted = performance.now();
    await document.fonts.ready;
    if (stopped) return;
    font.readyAt = performance.now();
    font.status = document.fonts.status;
    stage = 'stable landing across two RAF intervals';
    let previous = geometry(node), stable = 0;
    const frames = [];
    while (!stopped) {
      const timestamp = await nextFrame();
      if (stopped) return;
      const currentNode = heading();
      const current = currentNode && geometry(currentNode);
      stable = currentNode === node && document.fonts.status === 'loaded' && sameGeometry(previous, current) ? stable + 1 : 0;
      frames.push(timestamp);
      if (frames.length > 3) frames.shift();
      lastGeometry = current;
      previous = current;
      node = currentNode;
      if (stable >= 2) return { heading: node.textContent.trim(), geometry: current, frames, stableRafIntervals: stable };
    }
  };
  const report = async result => {
    const body = { ...result, scope, nav: navigation(), font: { ...font, status: document.fonts.status },
      resources: resources(), durationFromNavigation: performance.now(), visibility: document.visibilityState,
      observerStarted: started, observerDuration: performance.now() - started };
    console.info('office-performance:startup', JSON.stringify(body));
    if (!config || typeof config.reportUrl !== 'string' || !config.reportUrl) throw Error('Missing __OFFICE_PERFORMANCE__.reportUrl');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(config.reportUrl, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw Error(`Startup report POST failed: HTTP ${response.status}`);
    } finally { clearTimeout(timer); }
  };
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(Error(`Startup readiness exceeded 10000ms at ${stage}; visibility=${document.visibilityState}`)), Math.max(0, expiresAt - performance.now()));
  });
  void (async () => {
    let result;
    try {
      const evidence = await Promise.race([observe(), deadline]);
      result = { status: 'passed', evidence };
    } catch (error) {
      result = { status: 'error', error: errorText(error), diagnostics: { stage, readyState: document.readyState,
        headingPresent: !!heading(), geometry: lastGeometry, fonts: document.fonts.status } };
    } finally {
      stopped = true;
      clearTimeout(deadlineTimer);
      if (frameId !== undefined) cancelAnimationFrame(frameId);
      removeDomListener();
    }
    await report(result);
  })().catch(error => console.error('office-performance:startup_report_failed', errorText(error)));
})();
