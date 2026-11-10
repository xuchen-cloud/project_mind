import type { Mermaid, MermaidConfig } from 'mermaid';
import type { DiagramResult } from '../genoffice/editor/diagrams';
import type { DiagramTheme } from './diagramTheme';

export const MERMAID_LANGUAGE = 'mermaid';
export const MERMAID_TEMPLATE = [
  '```mermaid', 'flowchart LR', '    A[开始] --> B{确认方案}',
  '    B -->|通过| C[完成]', '    B -->|调整| A', '```',
].join('\n');

// The neutral hierarchy of beautiful-mermaid's zinc themes inspired this
// adaptation. Colors and configuration are Project Mind's own; keep Mermaid's
// complete syntax rather than replacing it with a subset renderer.
export function mermaidConfig(theme: DiagramTheme): MermaidConfig {
  const dark = theme === 'dark';
  const colors = dark
    ? { background: '#202124', text: '#eeece6', surface: '#2c2e32', border: '#777973', line: '#a5aaa5', accent: '#80b7e9', soft: '#283a4a', note: '#35342c' }
    : { background: '#fbfbfa', text: '#37352f', surface: '#f3f2ee', border: '#98958c', line: '#77736b', accent: '#1976c9', soft: '#edf4fa', note: '#f6f1e4' };
  return {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    theme: 'base', htmlLabels: false,
    fontFamily: 'SF Pro Text, -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif',
    themeVariables: {
      darkMode: dark, background: colors.background, fontSize: '15px',
      primaryColor: colors.surface, primaryTextColor: colors.text, primaryBorderColor: colors.border,
      secondaryColor: colors.soft, secondaryTextColor: colors.text, secondaryBorderColor: colors.accent,
      tertiaryColor: colors.background, tertiaryTextColor: colors.text, tertiaryBorderColor: colors.border,
      lineColor: colors.line, textColor: colors.text, mainBkg: colors.surface,
      nodeBorder: colors.border, clusterBkg: colors.background, clusterBorder: colors.border,
      edgeLabelBackground: colors.background, titleColor: colors.text,
      actorBkg: colors.surface, actorBorder: colors.border, actorTextColor: colors.text,
      actorLineColor: colors.line, signalColor: colors.line, signalTextColor: colors.text,
      labelBoxBkgColor: colors.soft, labelBoxBorderColor: colors.border, labelTextColor: colors.text,
      loopTextColor: colors.text, noteBkgColor: colors.note, noteBorderColor: colors.border,
      noteTextColor: colors.text, activationBkgColor: colors.soft, activationBorderColor: colors.accent,
    },
    flowchart: { htmlLabels: false, curve: 'basis', nodeSpacing: 32, rankSpacing: 48, padding: 16 },
    sequence: { actorMargin: 48, boxMargin: 12, messageMargin: 32, noteMargin: 12, wrap: true },
  };
}

let loading: Promise<Mermaid> | null = null;
export function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then(({ default: mermaid }) => mermaid).catch(error => {
    loading = null;
    throw error;
  });
  return loading;
}

let renderSeq = 0;
let rendering: Promise<unknown> = Promise.resolve();
export function renderMermaid(source: string, theme: DiagramTheme = 'light'): Promise<DiagramResult> {
  // Mermaid's configuration is global. Hold initialize + render together so
  // concurrent dark previews and light exports cannot change each other's ink.
  const next = rendering.then(async (): Promise<DiagramResult> => {
    try {
      const mermaid = await loadMermaid();
      const config = mermaidConfig(theme);
      mermaid.initialize(config);
      const { svg } = await mermaid.render(`md-mermaid-${++renderSeq}`, source);
      // A standalone SVG/image has no host surface. Carry its paper as well as
      // its ink so dark labels remain legible in every container and decoder.
      const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      root.style.backgroundColor = String(mermaid.mermaidAPI.getConfig().themeVariables.background ?? config.themeVariables.background);
      return { ok: true, svg: root.outerHTML };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  rendering = next;
  return next;
}
