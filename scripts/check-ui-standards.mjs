import fs from "node:fs";
import path from "node:path";
import { collectMotionViolations } from "./ui-standards-motion-rules.mjs";

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");
const srcFile = (...segments) => path.join(srcRoot, ...segments);

const allowedTauriFiles = new Set([
  srcFile("services", "appUpdater.ts"),
  srcFile("services", "desktopApi.ts"),
  srcFile("lib", "project-window.ts"),
  srcFile("lib", "aiJobs.ts"),
  srcFile("hooks", "useWindowFileDrop.ts"),
  srcFile("hooks", "useWorkspaceWindowSizeConstraints.ts"),
]);

const allowedHardcodedColorFiles = new Set([
  srcFile("styles", "app.css"),
  srcFile("services", "desktopApi.ts"),
  srcFile("services", "projectMindApi.ts"),
  srcFile("components", "rich-editor", "ImageAnnotationDialog.tsx"),
  srcFile("components", "rich-editor", "image-annotations.ts"),
  // Export artifacts use a deterministic light print palette and must not inherit app theme tokens.
  srcFile("features", "record-export", "desktopRecordExportPlatform.ts"),
  srcFile("features", "record-export", "pdfGenerator.ts"),
  srcFile("ui", "components", "Button.tsx"),
  srcFile("ui", "components", "IconButton.tsx"),
  srcFile("ui", "components", "StatusBadge.tsx"),
  srcFile("ui", "components", "ToolbarButton.tsx"),
]);

const hardcodedColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/u;

const allowedHardcodedColorPatterns = [
  {
    files: new Set([srcFile("styles", "app.css")]),
    pattern: hardcodedColorPattern,
  },
  {
    files: new Set([
      srcFile("components", "rich-editor", "ImageAnnotationDialog.tsx"),
      srcFile("components", "rich-editor", "image-annotations.ts"),
    ]),
    pattern: hardcodedColorPattern,
  },
];

const legacyPatternRules = [
  { label: "color-ink", pattern: /color-ink/u },
  { label: "color-surface", pattern: /color-surface/u },
  { label: "bg-surface", pattern: /bg-surface/u },
  { label: "text-ink", pattern: /text-ink/u },
  { label: "surface-sidebar", pattern: /surface-sidebar/u },
  { label: "surface-hover", pattern: /surface-hover/u },
  { label: "success-bg", pattern: /success-bg/u },
  { label: "warning-bg", pattern: /warning-bg/u },
  { label: "error-bg", pattern: /error-bg/u },
  { label: "pm-todo", pattern: /pm-todo/u },
  { label: "useAppStore", pattern: /useAppStore/u },
  { label: "lib/api", pattern: /lib\/api/u },
  { label: "state/app-store", pattern: /state\/app-store/u },
];

const forbiddenImportRules = [
  { label: "react-icons", pattern: /from\s+["']react-icons/u },
  { label: "@heroicons", pattern: /from\s+["']@heroicons/u },
  { label: "phosphor-react", pattern: /from\s+["']phosphor-react/u },
];

const tauriPattern = /@tauri-apps\/[^"'\s)]*/u;
const emojiPattern = /\p{Extended_Pictographic}/u;

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test") {
        continue;
      }
      files.push(...walk(resolved));
      continue;
    }
    if (/\.(test|spec)\.(ts|tsx)$/u.test(entry.name)) {
      continue;
    }
    if (/\.(ts|tsx|css)$/u.test(entry.name)) {
      files.push(resolved);
    }
  }

  return files;
}

function isAllowedFile(file, allowedSet) {
  return allowedSet.has(file);
}

function findLineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function collectRegexMatches(content, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const matches = [];

  for (const match of content.matchAll(regex)) {
    matches.push({
      index: match.index ?? 0,
      text: match[0],
    });
  }

  return matches;
}

function shouldSkipRule(rule, file) {
  if (rule.skipFiles?.has(file)) {
    return true;
  }

  if (rule.onlyFiles && !rule.onlyFiles.has(file)) {
    return true;
  }

  return false;
}

function isAllowedHardcodedColor(file, matchText) {
  if (isAllowedFile(file, allowedHardcodedColorFiles)) {
    return true;
  }

  return allowedHardcodedColorPatterns.some((rule) => {
    if (!rule.files.has(file)) {
      return false;
    }

    return rule.pattern.test(matchText);
  });
}

function relativeFile(file) {
  return path.relative(projectRoot, file);
}

function formatSnippet(text) {
  return text.replace(/\s+/gu, " ").trim();
}

const violations = [];

function addViolation(file, content, index, message, snippet) {
  const relative = relativeFile(file);
  const line = findLineNumber(content, index);
  violations.push(`${relative}:${line} ${message}: ${formatSnippet(snippet)}`);
}

for (const file of walk(srcRoot)) {
  const content = fs.readFileSync(file, "utf8");

  for (const rule of legacyPatternRules) {
    if (shouldSkipRule(rule, file)) {
      continue;
    }

    for (const match of collectRegexMatches(content, rule.pattern)) {
      addViolation(file, content, match.index, "old design-system pattern", rule.label);
    }
  }

  if (!isAllowedFile(file, allowedTauriFiles)) {
    for (const match of collectRegexMatches(content, tauriPattern)) {
      addViolation(file, content, match.index, "direct Tauri import outside runtime adapter", match.text);
    }
  }

  for (const rule of forbiddenImportRules) {
    for (const match of collectRegexMatches(content, rule.pattern)) {
      addViolation(file, content, match.index, "non-Lucid icon library import", rule.label);
    }
  }

  for (const match of collectRegexMatches(content, hardcodedColorPattern)) {
    if (!isAllowedHardcodedColor(file, match.text)) {
      addViolation(file, content, match.index, "hardcoded color literal", match.text);
    }
  }

  if (!file.endsWith(".css")) {
    for (const match of collectRegexMatches(content, emojiPattern)) {
      addViolation(file, content, match.index, "emoji detected in source file", match.text);
    }
  }

  for (const violation of collectMotionViolations(relativeFile(file), content)) {
    violations.push(
      `${violation.file}:${violation.line} motion/${violation.rule}: ${formatSnippet(violation.snippet)}`,
    );
  }
}

if (violations.length > 0) {
  console.error("UI standards check failed:\n");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("UI standards check passed.");
