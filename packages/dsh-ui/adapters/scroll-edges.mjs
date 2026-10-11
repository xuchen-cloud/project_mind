/** Apply the main application's continuous edge fades to upstream list viewports. */
export function installScrollEdges(host) {
  const nodes = new Map();
  let frame = null;
  let disposed = false;
  const measure = () => {
    frame = null;
    if (disposed) return;
    for (const [node] of nodes) {
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      const position = Math.max(0, Math.min(max, node.scrollTop));
      const distance = Math.min(64, max / 2);
      const top = distance > 0 ? Math.min(1, position / distance) : 0;
      const bottom = distance > 0 ? Math.min(1, (max - position) / distance) : 0;
      node.style.setProperty('--dsh-edge-top', String(1 - top));
      node.style.setProperty('--dsh-edge-bottom', String(1 - bottom));
      node.style.setProperty('--dsh-edge-height', `${Math.min(40, node.clientHeight * .35)}px`);
      node.toggleAttribute('data-mind-scroll-edges', max > 0);
    }
  };
  const schedule = () => { if (!disposed && frame === null) frame = requestAnimationFrame(measure); };
  const resize = new ResizeObserver(schedule);
  const scan = () => {
    const current = new Set(host.querySelectorAll('[data-conversation-scroll], [data-trajectory-scroll], .dsh-ui-settings'));
    for (const [node, content] of nodes) if (!current.has(node)) {
      node.removeEventListener('scroll', schedule); resize.unobserve(node);
      if (content) resize.unobserve(content);
      nodes.delete(node);
    }
    for (const node of current) {
      if (!nodes.has(node)) { node.addEventListener('scroll', schedule, { passive: true }); resize.observe(node); }
      const oldContent = nodes.get(node);
      const content = node.firstElementChild;
      if (oldContent && oldContent !== content) resize.unobserve(oldContent);
      if (content) resize.observe(content);
      nodes.set(node, content);
    }
    schedule();
  };
  const changes = new MutationObserver(scan);
  changes.observe(host, { childList: true, subtree: true, characterData: true });
  scan();
  return () => {
    disposed = true;
    changes.disconnect(); resize.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    for (const node of nodes.keys()) {
      node.removeEventListener('scroll', schedule);
      node.removeAttribute('data-mind-scroll-edges');
      for (const name of ['--dsh-edge-top', '--dsh-edge-bottom', '--dsh-edge-height']) node.style.removeProperty(name);
    }
    nodes.clear();
  };
}
