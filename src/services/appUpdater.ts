import { getVersion } from "@tauri-apps/api/app";
import { desktopApi } from "./desktopApi";
import { check, type Update } from "@tauri-apps/plugin-updater";

export interface AppUpdate {
  version: string;
  notes: string | null;
}

export interface AppUpdaterClient {
  currentVersion(): Promise<string>;
  check(): Promise<AppUpdate | null>;
  install(update: AppUpdate): Promise<boolean | void>;
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
    if (!(await desktopApi.prepareVoiceLeave())) return false;
    await desktopApi.flushOtherWorkspaceWindows(true);
    await pendingUpdate.downloadAndInstall();
    await desktopApi.command("app_restart");
    return true;
  },
};
