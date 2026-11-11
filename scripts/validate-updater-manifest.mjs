import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const REQUIRED_TARGETS = ["windows-x86_64", "darwin-x86_64", "darwin-aarch64"];
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function parseUpdaterVersion(version) {
  const match = typeof version === "string" ? SEMVER_PATTERN.exec(version) : null;
  const prerelease = match?.[4]?.split(".") ?? [];
  if (!match || prerelease.some((part) => /^0\d+$/u.test(part))) {
    throw new Error("updater manifest version must be valid SemVer");
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

// SemVer precedence ignores build metadata. BigInt preserves numeric ordering
// without rounding large core or prerelease identifiers.
export function compareUpdaterVersions(left, right) {
  const a = parseUpdaterVersion(left);
  const b = parseUpdaterVersion(right);
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Number(b.prerelease.length > 0) - Number(a.prerelease.length > 0);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function isPublicReleaseAssetUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.origin === "https://github.com" &&
      url.pathname.startsWith(
        "/xuchen-cloud/project_mind/releases/download/",
      )
    ) {
      return true;
    }
    return (
      url.origin === "https://api.github.com" &&
      /^\/repos\/xuchen-cloud\/project_mind\/releases\/assets\/\d+$/u.test(
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
  parseUpdaterVersion(manifest.version);
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
