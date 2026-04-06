import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const srcRoot = path.join(projectRoot, "src");

const allowedTauriFiles = new Set([
  path.join(srcRoot, "services", "desktopApi.ts"),
]);

const ignoredColorFiles = new Set([
  path.join(srcRoot, "styles", "app.css"),
  path.join(srcRoot, "services", "desktopApi.ts"),
  path.join(srcRoot, "services", "projectMindApi.ts"),
  path.join(srcRoot, "ui", "components", "Button.tsx"),
  path.join(srcRoot, "ui", "components", "IconButton.tsx"),
  path.join(srcRoot, "ui", "components", "StatusBadge.tsx"),
  path.join(srcRoot, "ui", "components", "ToolbarButton.tsx"),
]);

const oldPatterns = [
  /color-ink/u,
  /color-surface/u,
  /font-size-/u,
  /bg-surface/u,
  /text-ink/u,
  /surface-sidebar/u,
  /surface-hover/u,
  /success-bg/u,
  /warning-bg/u,
  /error-bg/u,
  /pm-todo/u,
  /useAppStore/u,
  /lib\/api/u,
  /state\/app-store/u,
];

const forbiddenImports = [
  /from\s+["']react-icons/u,
  /from\s+["']@heroicons/u,
  /from\s+["']phosphor-react/u,
];

const hardcodedColorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(/u;
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

const violations = [];

for (const file of walk(srcRoot)) {
  const content = fs.readFileSync(file, "utf8");
  const relative = path.relative(projectRoot, file);

  for (const pattern of oldPatterns) {
    if (pattern.test(content)) {
      violations.push(`${relative}: old design-system pattern "${pattern.source}"`);
    }
  }

  if (!allowedTauriFiles.has(file) && /@tauri-apps/u.test(content)) {
    violations.push(`${relative}: direct Tauri import outside services/desktopApi.ts`);
  }

  for (const pattern of forbiddenImports) {
    if (pattern.test(content)) {
      violations.push(`${relative}: non-Lucid icon library import`);
    }
  }

  if (!ignoredColorFiles.has(file) && hardcodedColorPattern.test(content)) {
    violations.push(`${relative}: hardcoded color literal detected`);
  }

  if (!file.endsWith(".css") && emojiPattern.test(content)) {
    violations.push(`${relative}: emoji detected in source file`);
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
