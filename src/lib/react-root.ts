import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

export function renderReactRoot(
  container: HTMLElement,
  children: ReactNode,
  hotData?: { reactRoot?: Root },
): Root {
  const root = hotData?.reactRoot ?? createRoot(container);
  if (hotData) hotData.reactRoot = root;
  root.render(children);
  return root;
}
