// @vitest-environment node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { advanceBetaChannel, decideBetaChannel } from "./advance-beta-channel.mjs";

const temporaryDirectories = [];
const targets = ["windows-x86_64", "darwin-x86_64", "darwin-aarch64"];

function manifest(version) {
  return {
    version,
    platforms: Object.fromEntries(targets.map((target) => [target, {
      url: `https://github.com/xuchen-cloud/project_mind/releases/download/v${version}/${target}.tar.gz`,
      signature: `signed-${target}-${version}`,
    }])),
  };
}

function git(repository, ...args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function channelFixture() {
  const root = mkdtempSync(join(tmpdir(), "mind-beta-channel-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const checkout = join(root, "release-repository");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, checkout);
  git(checkout, "config", "user.name", "Beta fixture");
  git(checkout, "config", "user.email", "beta@example.invalid");
  writeFileSync(join(checkout, "README.md"), "public release repository\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-m", "Initial public branch");
  git(checkout, "push", "origin", "main");
  return {
    root,
    remote,
    checkout,
    head: () => git(remote, "rev-parse", "main"),
    current: () => JSON.parse(git(remote, "show", "main:beta/latest.json")),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Beta channel advancement", () => {
  it("keeps B current when an older A finishes after B, even with a stale checkout", () => {
    const fixture = channelFixture();
    expect(advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.2")).action)
      .toBe("advance");
    const afterB = fixture.head();

    expect(advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.1")))
      .toMatchObject({ action: "reject", reason: "older-version" });
    expect(fixture.head()).toBe(afterB);
    expect(fixture.current().version).toBe("1.0.0-beta.2");
  });

  it("repeats the same candidate without creating a new channel commit", () => {
    const fixture = channelFixture();
    const candidate = manifest("1.0.0-beta.2");
    advanceBetaChannel(fixture.checkout, candidate);
    const original = fixture.head();
    const reordered = {
      ...candidate,
      notes: "updated release notes",
      pub_date: "2026-11-11T00:00:00Z",
      platforms: Object.fromEntries(Object.entries(candidate.platforms).reverse()),
    };

    expect(advanceBetaChannel(fixture.checkout, reordered).action).toBe("unchanged");
    expect(fixture.head()).toBe(original);
    expect(fixture.current()).toEqual(candidate);
  });

  it.each(["url", "signature"])("rejects a changed %s at the same version", (field) => {
    const fixture = channelFixture();
    const current = manifest("1.0.0-beta.2");
    advanceBetaChannel(fixture.checkout, current);
    const original = fixture.head();
    const candidate = structuredClone(current);
    candidate.platforms["windows-x86_64"][field] += "-rebuilt";

    expect(advanceBetaChannel(fixture.checkout, candidate))
      .toMatchObject({ action: "reject", reason: "same-version-different-assets" });
    expect(fixture.head()).toBe(original);
    expect(fixture.current()).toEqual(current);
  });

  it("advances a higher version on the latest remote parent and preserves other files", () => {
    const fixture = channelFixture();
    advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.2"));
    const other = join(fixture.root, "other-publisher");
    git(fixture.root, "clone", fixture.remote, other);
    git(other, "config", "user.name", "Other fixture");
    git(other, "config", "user.email", "other@example.invalid");
    writeFileSync(join(other, "unrelated.txt"), "retain remote content\n");
    git(other, "add", "unrelated.txt");
    git(other, "commit", "-m", "Unrelated remote change");
    git(other, "push", "origin", "main");
    const latest = fixture.head();

    const result = advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.10"));

    expect(result).toMatchObject({ action: "advance", baseCommit: latest });
    expect(git(fixture.remote, "rev-parse", "main^")).toBe(latest);
    expect(git(fixture.remote, "show", "main:unrelated.txt")).toBe("retain remote content");
    expect(fixture.current().version).toBe("1.0.0-beta.10");
    expect(git(fixture.checkout, "status", "--porcelain")).toBe("");
  });

  it("aborts a stale push when another publisher advances after the manifest read", () => {
    const fixture = channelFixture();
    advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.1"));
    const other = join(fixture.root, "other-publisher");
    git(fixture.root, "clone", fixture.remote, other);
    git(other, "config", "user.name", "Other fixture");
    git(other, "config", "user.email", "other@example.invalid");
    const hook = join(fixture.checkout, ".git/hooks/pre-push");
    // A real Git hook runs the competing publisher during the first push,
    // after its baseline was read. No Git operation is mocked.
    writeFileSync(hook, [
      `#!${process.execPath}`,
      `import { advanceBetaChannel } from ${JSON.stringify(new URL("./advance-beta-channel.mjs", import.meta.url).href)};`,
      `advanceBetaChannel(${JSON.stringify(other)}, ${JSON.stringify(manifest("1.0.0-beta.3"))});`,
      "",
    ].join("\n"));
    chmodSync(hook, 0o755);

    expect(() => advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.2")))
      .toThrow(/git push failed/u);
    expect(fixture.current().version).toBe("1.0.0-beta.3");
    const afterB = fixture.head();
    expect(advanceBetaChannel(fixture.checkout, manifest("1.0.0-beta.2")))
      .toMatchObject({ action: "reject", reason: "older-version" });
    expect(fixture.head()).toBe(afterB);
  });

  it("rejects a Windows-only patch without changing the all-platform channel", () => {
    const fixture = channelFixture();
    advanceBetaChannel(fixture.checkout, manifest("1.0.0"));
    const original = fixture.head();
    const patch = manifest("1.0.1-windows.1");
    delete patch.platforms["darwin-x86_64"];
    delete patch.platforms["darwin-aarch64"];

    expect(() => advanceBetaChannel(fixture.checkout, patch))
      .toThrow("missing updater target darwin-x86_64");
    expect(fixture.head()).toBe(original);
    expect(fixture.current().version).toBe("1.0.0");
  });

  it("runs the standalone CLI against only a local fixture and reports rejection", () => {
    const fixture = channelFixture();
    mkdirSync(join(fixture.root, "scripts"));
    mkdirSync(join(fixture.root, "updater-channel"));
    for (const script of ["advance-beta-channel.mjs", "validate-updater-manifest.mjs"]) {
      copyFileSync(fileURLToPath(new URL(`./${script}`, import.meta.url)), join(fixture.root, "scripts", script));
    }
    const publish = (candidate) => {
      writeFileSync(join(fixture.root, "updater-channel/latest.json"), JSON.stringify(candidate));
      return spawnSync(process.execPath, ["scripts/advance-beta-channel.mjs", "release-repository", "updater-channel/latest.json"], { cwd: fixture.root, encoding: "utf8" });
    };

    const first = publish(manifest("2.0.0"));
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).action).toBe("advance");
    expect(JSON.parse(publish(manifest("2.0.0")).stdout).action).toBe("unchanged");
    const original = fixture.head();
    const late = publish(manifest("1.0.0"));
    expect(late.status).toBe(1);
    expect(JSON.parse(late.stdout)).toMatchObject({ action: "reject", reason: "older-version" });
    expect(fixture.head()).toBe(original);
  });
});

describe("Beta candidate decision", () => {
  it.each([
    ["1.9.0", "1.10.0"],
    ["1.99.99", "2.0.0"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-beta.11", "1.0.0-rc.1"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-beta.9007199254740992", "1.0.0-beta.9007199254740993"],
    ["9007199254740992.0.0", "9007199254740993.0.0"],
  ])("orders %s before %s by SemVer precedence", (older, newer) => {
    expect(decideBetaChannel(manifest(older), manifest(newer))).toEqual({ action: "advance" });
    expect(decideBetaChannel(manifest(newer), manifest(older)))
      .toEqual({ action: "reject", reason: "older-version" });
  });

  it("ignores a v prefix and build metadata without allowing replacement assets", () => {
    const current = manifest("1.0.0-beta.2+build.1");
    const sameAssets = { ...current, version: "v1.0.0-beta.2+build.2" };
    expect(decideBetaChannel(current, sameAssets)).toEqual({ action: "unchanged" });
    expect(decideBetaChannel(current, manifest("1.0.0-beta.2+build.2")))
      .toEqual({ action: "reject", reason: "same-version-different-assets" });
  });
});
