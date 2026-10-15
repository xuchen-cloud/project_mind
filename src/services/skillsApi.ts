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
  list: (projectId: number | null = null) =>
    desktopApi.command<SkillCatalog>("skills_list", { projectId }),
  manage: (projectId: number | null, entryPath: string, action: SkillAction) =>
    desktopApi.command<SkillCatalog>("skills_manage", { projectId, entryPath, action }),
};
