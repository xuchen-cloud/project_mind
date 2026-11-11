import fs from "node:fs";
import { createHash } from "node:crypto";

import { collectPortablePathViolations } from "./portable-path-rules.mjs";

const evidence = JSON.parse(fs.readFileSync(new URL("./portable-path-evidence.json", import.meta.url), "utf8"));

export function isGeneratedDocumentation(file) {
  return file.startsWith(".full-review/");
}

export function collectDocumentationPathViolations(file, source) {
  if (isGeneratedDocumentation(file)) return [];
  const allowed = new Map(
    (evidence.files.find((entry) => entry.file === file)?.lines ?? [])
      .map((line) => [line.sha256, line.occurrences]),
  );
  const exemptLines = new Set();
  source.split("\n").forEach((line, index) => {
    const digest = createHash("sha256").update(line).digest("hex");
    const remaining = allowed.get(digest) ?? 0;
    if (remaining > 0) {
      exemptLines.add(index + 1);
      allowed.set(digest, remaining - 1);
    }
  });
  return collectPortablePathViolations(file, source)
    .filter((violation) => !exemptLines.has(violation.line));
}
