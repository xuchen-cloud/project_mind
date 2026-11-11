import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { collectDocumentationPathViolations, isGeneratedDocumentation } from "./portable-path-policy.mjs";

const projectRoot = process.cwd();
// Check tracked and new authored docs. Git's ignore rules keep materialized
// dependencies/build outputs out; generated review reports have an explicit scope.
const files = [...new Set(execFileSync(
  "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: projectRoot, encoding: "utf8" },
).split("\0"))].filter((file) =>
  file.endsWith(".md") && !isGeneratedDocumentation(file) && fs.existsSync(file),
);

const violations = files.flatMap((file) =>
  collectDocumentationPathViolations(file, fs.readFileSync(file, "utf8")),
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
