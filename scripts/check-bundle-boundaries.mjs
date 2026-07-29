import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const distIndexPath = resolve(process.cwd(), "dist/index.html");
const html = await readFile(distIndexPath, "utf8");
const mainScriptHref = html.match(/<script[^>]+src="([^"]+)"/u)?.[1];
const preloadHrefs = [...html.matchAll(/rel="modulepreload"[^>]+href="([^"]+)"/gu)].map(
  (match) => match[1] ?? "",
);
const forbiddenPreloads = preloadHrefs.filter((href) =>
  /(canvas|konva|ImageAnnotationDialog)/iu.test(href),
);

if (forbiddenPreloads.length > 0) {
  console.error(
    `Heavy image annotation code must remain lazy, but was preloaded: ${forbiddenPreloads.join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Bundle boundary check passed: image annotation code is lazy.");
}

if (!mainScriptHref) {
  throw new Error("Could not locate the main production script in dist/index.html");
}

const mainScriptSize = (await stat(resolve(process.cwd(), "dist", mainScriptHref.replace(/^\//u, ""))))
  .size;
const MAIN_SCRIPT_BUDGET_BYTES = 250 * 1024;
if (mainScriptSize > MAIN_SCRIPT_BUDGET_BYTES) {
  console.error(
    `Main script is ${Math.ceil(mainScriptSize / 1024)} KiB; budget is ${MAIN_SCRIPT_BUDGET_BYTES / 1024} KiB.`,
  );
  process.exitCode = 1;
} else {
  console.log(`Main script budget passed: ${Math.ceil(mainScriptSize / 1024)} KiB / 250 KiB.`);
}
