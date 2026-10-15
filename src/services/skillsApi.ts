import { desktopApi } from "./desktopApi";

export interface DiscoveredSkill {
  name: string;
  description: string;
  path: string | null;
  source: string;
}

export interface SkillCatalog {
  skills: DiscoveredSkill[];
  directories: string[];
  complete: boolean;
}

export const skillsApi = {
  list: (projectId: number | null = null) =>
    desktopApi.command<SkillCatalog>("skills_list", { projectId }),
};
