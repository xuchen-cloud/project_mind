import { afterEach, expect, it, vi } from "vitest";
import { measureTabLabels } from "./tab-strip";

afterEach(() => { vi.restoreAllMocks(); });
it("clamps short names, fits middle names and caps long names at the shared responsive standard", () => {
  const viewport = document.createElement("div"), list = document.createElement("div");
  viewport.append(list); document.body.append(viewport);
  let available = 900;
  Object.defineProperty(viewport, "clientWidth", { get: () => available });
  const lengths = [20, 110, 250];
  for (const [index, length] of lengths.entries()) {
    const tab = document.createElement("div"); tab.className = "compact-tab";
    const trigger = document.createElement("button"); trigger.className = "compact-tab__trigger";
    const label = document.createElement("span"); label.className = "compact-tab__label";
    label.textContent = String(index); Object.defineProperty(label, "scrollWidth", { configurable: true, value: length });
    trigger.append(label); tab.append(trigger); list.append(tab);
  }
  try {
    const widths = () => [...list.children].map(node => parseFloat((node as HTMLElement).style.width));
    measureTabLabels(list); expect(widths()).toEqual([96, 110, 148]);
    available = 360; measureTabLabels(list); expect(widths()).toEqual([96, 110, 120]);
    available = 200; measureTabLabels(list); expect(widths()).toEqual([96, 96, 96]);
    const long = list.querySelectorAll<HTMLElement>(".compact-tab__label")[2];
    expect(long).toHaveAttribute("data-clipped");
    Object.defineProperty(long, "scrollWidth", { value: 40 });
    available = 900; measureTabLabels(list); expect(widths()).toEqual([96, 110, 96]);
    expect(long).not.toHaveAttribute("data-clipped");
  } finally { viewport.remove(); }
});
