import { readFile } from "node:fs/promises";

function fail(message) {
  process.stderr.write(`Windows patch release validation failed: ${message}\n`);
  process.exitCode = 1;
}

function readTomlPackageVersion(contents, packageName) {
  const packageBlock = contents.match(
    new RegExp(
      `(?:^|\\n)\\[\\[?package\\]?\\]\\s*\\n(?:[^\\n]*\\n)*?name\\s*=\\s*"${packageName}"(?:[^\\n]*\\n)*?version\\s*=\\s*"([^"]+)"`,
      "u",
    ),
  );
  return packageBlock?.[1] ?? null;
}

const tag = process.argv[2] ?? "";
const tagMatch = /^v(\d+\.\d+\.\d+)-windows\.([1-9]\d*)$/u.exec(tag);

if (!tagMatch) {
  fail('tag must use the form "v<major>.<minor>.<patch>-windows.<build>"');
} else {
  const expectedVersion = tagMatch[1];
  const [packageJson, packageLock, tauriConfig, cargoToml, cargoLock] =
    await Promise.all([
      readFile("package.json", "utf8").then(JSON.parse),
      readFile("package-lock.json", "utf8").then(JSON.parse),
      readFile("src-tauri/tauri.conf.json", "utf8").then(JSON.parse),
      readFile("src-tauri/Cargo.toml", "utf8"),
      readFile("src-tauri/Cargo.lock", "utf8"),
    ]);
  const versions = new Map([
    ["package.json", packageJson.version],
    ["package-lock.json", packageLock.version],
    ["package-lock.json root package", packageLock.packages?.[""]?.version],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
    ["src-tauri/Cargo.toml", readTomlPackageVersion(cargoToml, "project_mind_alpha")],
    ["src-tauri/Cargo.lock", readTomlPackageVersion(cargoLock, "project_mind_alpha")],
  ]);
  const mismatches = Array.from(versions).filter(
    ([, version]) => version !== expectedVersion,
  );

  if (mismatches.length > 0) {
    fail(
      `${tag} does not match application version ${expectedVersion}: ${mismatches
        .map(([file, version]) => `${file}=${version ?? "missing"}`)
        .join(", ")}`,
    );
  } else {
    process.stdout.write(
      `Windows patch tag ${tag} matches application version ${expectedVersion}.\n`,
    );
  }
}
