const MIN_TAB_WIDTH = 96;
const MAX_TAB_WIDTH = 148;
const pixels = (value: string) => parseFloat(value) || 0;

/** Share the responsive cap, while measuring each title's own required width. */
export function measureTabLabels(list: HTMLElement | null) {
  if (!list?.parentElement) return;
  const labels = [...list.querySelectorAll<HTMLElement>(".compact-tab__label")];
  if (!labels.length) return;
  const listStyle = getComputedStyle(list);
  const workspace = list.querySelector<HTMLElement>(".workspace-topbar__tab--workspace");
  const gap = pixels(listStyle.columnGap);
  const available = list.parentElement.clientWidth - pixels(listStyle.paddingLeft) - pixels(listStyle.paddingRight)
    - (workspace?.offsetWidth ?? 0) - gap * (labels.length + (workspace ? 1 : 0) - 1);
  const standard = Math.max(MIN_TAB_WIDTH, Math.min(MAX_TAB_WIDTH, available / labels.length));
  list.style.setProperty("--tab-standard-width", `${standard}px`);
  labels.forEach(label => label.removeAttribute("data-clipped"));
  const measurements = labels.map(label => {
    const tab = label.closest<HTMLElement>(".compact-tab")!;
    const trigger = label.closest<HTMLElement>(".compact-tab__trigger")!;
    const tabStyle = getComputedStyle(tab), triggerStyle = getComputedStyle(trigger);
    const other = [...trigger.children].filter(node => node !== label);
    const natural = label.scrollWidth + other.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0)
      + pixels(triggerStyle.columnGap) * other.length
      + pixels(triggerStyle.paddingLeft) + pixels(triggerStyle.paddingRight)
      + pixels(tabStyle.paddingLeft) + pixels(tabStyle.paddingRight);
    return { label, tab, width: Math.max(MIN_TAB_WIDTH, Math.min(standard, natural)), clipped: natural > standard + 1 };
  });
  measurements.forEach(({ label, tab, width, clipped }) => {
    tab.style.width = `${width}px`;
    label.toggleAttribute("data-clipped", clipped);
  });
}
