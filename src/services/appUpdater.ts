import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export interface AppUpdate {
  version: string;
  notes: string | null;
}

export interface AppUpdaterClient {
  currentVersion(): Promise<string>;
  check(): Promise<AppUpdate | null>;
  install(update: AppUpdate): Promise<void>;
}

let pendingUpdate: Update | null = null;

export const tauriAppUpdater: AppUpdaterClient = {
  currentVersion: getVersion,
  async check() {
    pendingUpdate = await check();
    if (!pendingUpdate) {
      return null;
    }
    return {
      version: pendingUpdate.version,
      notes: pendingUpdate.body ?? null,
    };
  },
  async install(update) {
    if (!pendingUpdate || pendingUpdate.version !== update.version) {
      throw new Error("需要重新检查更新后再安装");
    }
    await pendingUpdate.downloadAndInstall();
    await relaunch();
  },
};
