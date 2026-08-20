import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_TARGETS = ["windows-x86_64", "darwin-x86_64", "darwin-aarch64"];
const SEMVER_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function isPublicReleaseAssetUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.origin === "https://github.com" &&
      url.pathname.startsWith(
        "/xuchen-cloud/project-mind-releases/releases/download/",
      )
    ) {
      return true;
    }
    return (
      url.origin === "https://api.github.com" &&
      /^\/repos\/xuchen-cloud\/project-mind-releases\/releases\/assets\/\d+$/u.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}

export function validateUpdaterManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("updater manifest must be an object");
  }
  if (typeof manifest.version !== "string" || !SEMVER_PATTERN.test(manifest.version)) {
    throw new Error("updater manifest version must be valid SemVer");
  }
  if (!manifest.platforms || typeof manifest.platforms !== "object") {
    throw new Error("updater manifest platforms must be an object");
  }

  for (const target of REQUIRED_TARGETS) {
    const platform = manifest.platforms[target];
    if (!platform || typeof platform !== "object") {
      throw new Error(`missing updater target ${target}`);
    }
    if (typeof platform.url !== "string" || !isPublicReleaseAssetUrl(platform.url)) {
      throw new Error(`updater target ${target} must use the public release repository`);
    }
    if (typeof platform.signature !== "string" || !platform.signature.trim()) {
      throw new Error(`updater target ${target} is missing its signature`);
    }
  }
}

async function runCli() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("usage: node scripts/validate-updater-manifest.mjs <latest.json>");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateUpdaterManifest(manifest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
