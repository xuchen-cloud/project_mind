import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEV_URL = "http://localhost:1420";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const VITE_ENTRY = path.join(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

async function main() {
  if (await isReusableDevServerRunning()) {
    console.log(`[tauri-dev] Reusing existing dev server at ${DEV_URL}`);
    return;
  }

  const child = spawn(process.execPath, [VITE_ENTRY, "--host", "0.0.0.0", "--port", "1420"], {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
  });

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
