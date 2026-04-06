import { spawn } from "node:child_process";

const DEV_URL = "http://localhost:1420";
const VITE_ENTRY =
  process.platform === "win32"
    ? "node_modules/vite/bin/vite.js"
    : "node_modules/.bin/vite";

async function main() {
  if (await isReusableDevServerRunning()) {
    console.log(`[tauri-dev] Reusing existing dev server at ${DEV_URL}`);
    return;
  }

  const child = spawn(
    VITE_ENTRY,
    ["--host", "0.0.0.0", "--port", "1420"],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

async function isReusableDevServerRunning() {
  try {
    const response = await fetch(DEV_URL);

    if (!response.ok) {
      return false;
    }

    const body = await response.text();
    return body.includes("/@vite/client") && body.includes("Project Mind Alpha");
  } catch {
    return false;
  }
}

void main();
