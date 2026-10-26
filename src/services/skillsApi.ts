import { desktopApi } from "./desktopApi";

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string | null;
  source: string;
  disabled: boolean;
  entryPath: string | null;
  directory: string | null;
  canDelete: boolean;
}

export type SkillAction = "enable" | "disable" | "delete";

export interface SkillCatalog {
  skills: DiscoveredSkill[];
  directories: string[];
  complete: boolean;
}

export const skillsApi = {
  import: (projectId: number | null, archivePath: string) =>
    desktopApi.command<SkillCatalog>("skills_import", { projectId, archivePath }),
  list: (projectId: number | null = null, options?: { requestId: string; refresh: boolean }) =>
    desktopApi.command<SkillCatalog>("skills_list", { projectId, ...options }),
  cancel: (requestId: string) =>
    desktopApi.command<null>("skills_list", { requestId, cancel: true }),
  manage: (projectId: number | null, entryPath: string, action: SkillAction) =>
    desktopApi.command<SkillCatalog>("skills_manage", { projectId, entryPath, action }),
};
