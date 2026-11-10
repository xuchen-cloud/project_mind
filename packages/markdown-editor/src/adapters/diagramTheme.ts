import { useSyncExternalStore } from 'react';

export type DiagramTheme = 'light' | 'dark';

export function getDiagramTheme(): DiagramTheme {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement;
  if (root.dataset.theme === 'dark' || root.dataset.theme === 'light') return root.dataset.theme;
  if (root.classList.contains('dark')) return 'dark';
  return getComputedStyle(root).colorScheme === 'dark' ? 'dark' : 'light';
}

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  return () => observer.disconnect();
}

export function useDiagramTheme(): DiagramTheme {
  return useSyncExternalStore(subscribe, getDiagramTheme, () => 'light');
}
