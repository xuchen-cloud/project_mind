export const queryKeys = {
  workspaceStatus: ["workspace-status"] as const,
  projects: {
    all: ["projects", "all"] as const,
  },
  projectPage: (projectId: number | null) => ["project-page", projectId] as const,
  workspacePage: ["workspace-page"] as const,
  todoCollections: {
    all: ["todos"] as const,
    workspaceOwned: ["todos", "workspace-owned"] as const,
    projectOwned: (projectId: number) => ["todos", "project-owned", projectId] as const,
    workspaceRail: ["todos", "workspace-rail"] as const,
  },
  aiArtifacts: ["ai-artifact"] as const,
  aiSettings: ["ai-settings"] as const,
  richTextStyle: ["rich-text-style"] as const,
  projectTags: {
    all: ["project-tag-settings"] as const,
    workspace: ["project-tag-settings", "workspace"] as const,
    project: (projectId: number | null) => ["project-tag-settings", projectId] as const,
  },
  contacts: {
    all: ["contacts"] as const,
  },
  documentVersions: (documentId: number) => ["documentVersions", documentId] as const,
  search: (query: string, projectId: number | null = null) =>
    ["search", projectId === null ? "workspace" : "project", projectId, query] as const,
} as const;
