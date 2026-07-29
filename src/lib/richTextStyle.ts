import type { CSSProperties } from "react";

import type {
  RichTextFontPreset,
  RichTextFontSelection,
  RichTextStyleSettings,
} from "./types";

export const DEFAULT_RICH_TEXT_STYLE_SETTINGS: RichTextStyleSettings = {
  body: {
    fontFamily: createPresetFontSelection("workspace_sans"),
    fontSizePx: 14,
    lineHeight: 1.6,
    paragraphSpacingBeforePx: 12,
    paragraphSpacingAfterPx: 0,
  },
  headings: {
    fontFamily: createPresetFontSelection("workspace_sans"),
    lineHeight: 1.35,
    paragraphSpacingBeforePx: 12,
    paragraphSpacingAfterPx: 0,
    h1SizePx: 24,
    h2SizePx: 20,
    h3SizePx: 16,
  },
  list: {
    fontFamily: createPresetFontSelection("workspace_sans"),
    fontSizePx: 14,
    lineHeight: 1.6,
    paragraphSpacingBeforePx: 12,
    paragraphSpacingAfterPx: 0,
  },
};

export const RICH_TEXT_FONT_PRESET_OPTIONS: Array<{
  value: RichTextFontPreset;
  label: string;
  description: string;
}> = [
  {
    value: "workspace_sans",
    label: "Workspace Sans",
    description: "沿用当前工作台默认字体栈，整体最稳定。",
  },
  {
    value: "work_sans",
    label: "Work Sans",
    description: "更清晰偏现代的无衬线，英文标题更利落。",
  },
  {
    value: "noto_sans_sc",
    label: "Noto Sans SC",
    description: "中文覆盖更完整，笔画更均匀。",
  },
  {
    value: "source_serif",
    label: "Source Serif",
    description: "更偏文稿气质，适合强调阅读感。",
  },
];

type RichTextStyleCssVarName =
  | "--rich-text-body-font-family"
  | "--rich-text-body-font-size"
  | "--rich-text-body-line-height"
  | "--rich-text-body-paragraph-spacing-before"
  | "--rich-text-body-paragraph-spacing-after"
  | "--rich-text-heading-font-family"
  | "--rich-text-heading-line-height"
  | "--rich-text-heading-paragraph-spacing-before"
  | "--rich-text-heading-paragraph-spacing-after"
  | "--rich-text-h1-font-size"
  | "--rich-text-h2-font-size"
  | "--rich-text-h3-font-size"
  | "--rich-text-list-font-family"
  | "--rich-text-list-font-size"
  | "--rich-text-list-line-height"
  | "--rich-text-list-paragraph-spacing-before"
  | "--rich-text-list-paragraph-spacing-after";

export const RICH_TEXT_STYLE_PREVIEW_HTML = [
  "<h1>项目阶段总结</h1>",
  "<p>把讨论、决定和待推进事项整理成稳定的项目记录，便于后续检索与回顾。</p>",
  "<h2>关键判断</h2>",
  "<p>当前方案优先保证记录效率，再通过统一排版让结论和行动项更容易被快速扫描。</p>",
  "<h3>接下来</h3>",
  "<ul><li>确认评审时间与参与人</li><li>补充预算拆分与风险说明</li><li>同步结论到项目总览</li></ul>",
  "<ol><li>更新材料</li><li>完成复盘</li></ol>",
].join("");

export function cloneRichTextStyleSettings(
  settings: RichTextStyleSettings,
): RichTextStyleSettings {
  return {
    body: {
      ...settings.body,
      fontFamily: cloneFontSelection(settings.body.fontFamily),
    },
    headings: {
      ...settings.headings,
      fontFamily: cloneFontSelection(settings.headings.fontFamily),
    },
    list: {
      ...settings.list,
      fontFamily: cloneFontSelection(settings.list.fontFamily),
    },
  };
}

export function createPresetFontSelection(preset: RichTextFontPreset): RichTextFontSelection {
  return { source: "preset", value: preset };
}

export function createSystemFontSelection(fontFamily: string): RichTextFontSelection {
  return { source: "system", value: fontFamily };
}

export function cloneFontSelection(selection: RichTextFontSelection): RichTextFontSelection {
  return { ...selection };
}

export function isRichTextFontPreset(value: string): value is RichTextFontPreset {
  return RICH_TEXT_FONT_PRESET_OPTIONS.some((option) => option.value === value);
}

export function resolveFontFamilyPreset(preset: RichTextFontPreset) {
  if (preset === "work_sans") {
    return "var(--font-editor-work-sans)";
  }
  if (preset === "noto_sans_sc") {
    return "var(--font-editor-noto-sans-sc)";
  }
  if (preset === "source_serif") {
    return "var(--font-editor-source-serif)";
  }
  return "var(--font-editor-workspace-sans)";
}

export function resolveFontFamilySelection(selection: RichTextFontSelection) {
  if (selection.source === "preset" && isRichTextFontPreset(selection.value)) {
    return resolveFontFamilyPreset(selection.value);
  }

  if (selection.source === "system") {
    const fontFamily = selection.value.trim();
    if (fontFamily.length > 0) {
      return `${quoteCssFontFamily(fontFamily)}, var(--font-ui)`;
    }
  }

  return resolveFontFamilyPreset("workspace_sans");
}

export function buildRichTextStyleCssVariables(
  settings: RichTextStyleSettings,
): Record<RichTextStyleCssVarName, string> {
  return {
    "--rich-text-body-font-family": resolveFontFamilySelection(settings.body.fontFamily),
    "--rich-text-body-font-size": `${settings.body.fontSizePx}px`,
    "--rich-text-body-line-height": String(settings.body.lineHeight),
    "--rich-text-body-paragraph-spacing-before": `${settings.body.paragraphSpacingBeforePx}px`,
    "--rich-text-body-paragraph-spacing-after": `${settings.body.paragraphSpacingAfterPx}px`,
    "--rich-text-heading-font-family": resolveFontFamilySelection(settings.headings.fontFamily),
    "--rich-text-heading-line-height": String(settings.headings.lineHeight),
    "--rich-text-heading-paragraph-spacing-before": `${settings.headings.paragraphSpacingBeforePx}px`,
    "--rich-text-heading-paragraph-spacing-after": `${settings.headings.paragraphSpacingAfterPx}px`,
    "--rich-text-h1-font-size": `${settings.headings.h1SizePx}px`,
    "--rich-text-h2-font-size": `${settings.headings.h2SizePx}px`,
    "--rich-text-h3-font-size": `${settings.headings.h3SizePx}px`,
    "--rich-text-list-font-family": resolveFontFamilySelection(settings.list.fontFamily),
    "--rich-text-list-font-size": `${settings.list.fontSizePx}px`,
    "--rich-text-list-line-height": String(settings.list.lineHeight),
    "--rich-text-list-paragraph-spacing-before": `${settings.list.paragraphSpacingBeforePx}px`,
    "--rich-text-list-paragraph-spacing-after": `${settings.list.paragraphSpacingAfterPx}px`,
  };
}

export function buildRichTextStyleInlineCssVariables(
  settings: RichTextStyleSettings,
): CSSProperties {
  return buildRichTextStyleCssVariables(settings) as CSSProperties;
}

export function applyRichTextStyleVariables(
  target: HTMLElement,
  settings: RichTextStyleSettings,
) {
  const entries = Object.entries(buildRichTextStyleCssVariables(settings));
  for (const [key, value] of entries) {
    target.style.setProperty(key, value);
  }
}

function quoteCssFontFamily(fontFamily: string) {
  return `"${fontFamily.trim().replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
