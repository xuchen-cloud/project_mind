import { desktopApi } from "./desktopApi";

/** System file TYPE icon, never the icon of the application that opens it. */
export const nativeFileIconApi = {
  typeIcon(name: string) {
    return desktopApi.fileCommand<string | null>("desktop_file_type_icon", { name });
  },
};
