import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { compareUpdaterVersions, validateUpdaterManifest } from "./validate-updater-manifest.mjs";

const CHANNEL_PATH = "beta/latest.json";
const CHANNEL_REF = "refs/heads/main";

export function decideBetaChannel(current, candidate) {
  validateUpdaterManifest(candidate);
  if (current === null) return { action: "advance" };
  validateUpdaterManifest(current);
  const precedence = compareUpdaterVersions(candidate.version, current.version);
  if (precedence < 0) return { action: "reject", reason: "older-version" };
  if (precedence > 0) return { action: "advance" };
  // Reordered JSON and release notes/date changes do not replace the same
  // signed assets. Equal precedence never permits different platform assets.
  return isDeepStrictEqual(candidate.platforms, current.platforms)
    ? { action: "unchanged" }
    : { action: "reject", reason: "same-version-different-assets" };
}

function git(repository, args, options = {}) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// The caller supplies a clone with origin pointing to the release repository
// and a configured commit identity. No checkout/index changes are needed.
// Any concurrent change to main aborts the push; a rerun makes a fresh decision.
export function advanceBetaChannel(repository, candidate) {
  git(repository, ["fetch", "--no-tags", "origin", CHANNEL_REF]);
  const baseCommit = git(repository, ["rev-parse", "FETCH_HEAD"]);
  const exists = git(repository, ["ls-tree", "--name-only", baseCommit, "--", CHANNEL_PATH]);
  const current = exists
    ? JSON.parse(git(repository, ["show", `${baseCommit}:${CHANNEL_PATH}`]))
    : null;
  const decision = decideBetaChannel(current, candidate);
  if (decision.action !== "advance") return { ...decision, baseCommit };

  const temporary = mkdtempSync(join(tmpdir(), "mind-beta-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
    git(repository, ["read-tree", baseCommit], { env });
    const blob = git(repository, ["hash-object", "-w", "--stdin"], {
      input: `${JSON.stringify(candidate, null, 2)}\n`,
    });
    git(repository, ["update-index", "--add", "--cacheinfo", `100644,${blob},${CHANNEL_PATH}`], { env });
    const tree = git(repository, ["write-tree"], { env });
    const commit = git(repository, ["commit-tree", tree, "-p", baseCommit, "-m", `release: advance Beta channel to ${candidate.version}`]);
    // The new commit is always a child of the exact manifest baseline. The
    // explicit lease also rejects a remote reset to an ancestor of that base.
    git(repository, ["push", `--force-with-lease=${CHANNEL_REF}:${baseCommit}`, "origin", `${commit}:${CHANNEL_REF}`]);
    return { action: "advance", baseCommit, commit };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runCli() {
  const [repository, candidatePath] = process.argv.slice(2);
  if (!repository || !candidatePath) {
    throw new Error("usage: node scripts/advance-beta-channel.mjs <release-repository> <latest.json>");
  }
  const result = advanceBetaChannel(repository, JSON.parse(readFileSync(candidatePath, "utf8")));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.action === "reject") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
