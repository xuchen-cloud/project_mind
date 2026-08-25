import fs from "node:fs";
import path from "node:path";

import { collectPortablePathViolations } from "./portable-path-rules.mjs";

const projectRoot = process.cwd();
const skippedDirectories = new Set([".git", "dist", "node_modules", "target"]);

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
      continue;
    }

    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(resolved));
    } else if (entry.name.endsWith(".md")) {
      files.push(resolved);
    }
  }
  return files;
}

const violations = walk(projectRoot).flatMap((file) =>
  collectPortablePathViolations(path.relative(projectRoot, file), fs.readFileSync(file, "utf8")),
);

if (violations.length > 0) {
  console.error("Portable path check failed:\n");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.rule}: ${violation.snippet}`,
    );
  }
  process.exit(1);
}

console.log("Portable path check passed.");
