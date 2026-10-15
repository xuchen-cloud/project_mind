import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import noriBust from "../../assets/home/nori-bust.png";

export function HomeWorkspaceRail({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hideBrand, setHideBrand] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      const list = root.querySelector<HTMLElement>(".todo-rail__list-scroll");
      const brand = root.querySelector<HTMLElement>(".home-brand");
      if (!list || !brand) return;
      // Compare against the space WITH the brand, even while it is hidden.
      // This avoids toggling forever when hiding it removes the overflow.
      const reserved = root.dataset.brandHidden === "true" ? brand.offsetHeight : 0;
      const available = list.clientHeight - reserved;
      const contentHeight = Math.max(0, ...Array.from(list.children, (child) => {
        const rect = child.getBoundingClientRect();
        return rect.bottom - list.getBoundingClientRect().top + list.scrollTop;
      }));
      setHideBrand(contentHeight > available + 1);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(root);
      root.querySelectorAll(".home-brand, .todo-rail__list-scroll, .todo-rail__list-scroll > *").forEach((node) => resize.observe(node));
      schedule();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(root, { childList: true, subtree: true });
    observe();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); };
  }, []);

  return (
    <div ref={rootRef} data-brand-hidden={hideBrand || undefined}
      className="home-rail home-rail--workspace">
      <div className="home-rail__todo">{children}</div>
      <div className="home-brand" aria-hidden={hideBrand || undefined}>
        <p>“让好想法，<br />在有上下文的地方持续推进。”</p>
        <small>— NoriMind</small><img src={noriBust} alt="Nori 小熊" />
      </div>
    </div>
  );
}
