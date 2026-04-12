import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getErrorMessage } from "../lib/errors";

interface PickFilter {
  name: string;
  extensions: string[];
}

interface PickFileOptions {
  title?: string;
  filters?: PickFilter[];
}

export const desktopApi = {
  async command<T>(name: string, payload?: Record<string, unknown>) {
    try {
      return await invoke<T>(name, payload);
    } catch (error) {
      throw new Error(getErrorMessage(error, `${name} 调用失败`));
    }
  },

  async pickDirectory(title = "选择文件夹") {
    const selected = await open({
      title,
      directory: true,
      multiple: false,
    });
    return Array.isArray(selected) ? selected[0] ?? null : selected;
  },

  async pickFile(options: PickFileOptions = {}) {
    const selected = await open({
      title: options.title,
      directory: false,
      multiple: false,
      filters: options.filters,
    });
    return Array.isArray(selected) ? selected[0] ?? null : selected;
  },

  async pickFiles(options: PickFileOptions = {}) {
    const selected = await open({
      title: options.title,
      directory: false,
      multiple: true,
      filters: options.filters,
    });

    if (!selected) {
      return [];
    }

    return Array.isArray(selected) ? selected : [selected];
  },

  openFile(path: string) {
    return invoke<void>("desktop_open_file", { path });
  },

  revealPath(path: string) {
    return this.revealInExplorer(path);
  },

  openFolder(path: string) {
    return invoke<void>("desktop_open_folder", { path });
  },

  revealInExplorer(path: string) {
    return invoke<void>("desktop_reveal_in_explorer", { path });
  },

  readFileAsDataUrl(path: string, mimeType?: string) {
    return invoke<string>("desktop_read_file_as_data_url", { path, mimeType });
  },

  listSystemFontFamilies() {
    return invoke<string[]>("desktop_list_system_font_families");
  },

  toFileUrl(path: string) {
    return convertFileSrc(path);
  },
};
