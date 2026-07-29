export const queryKeys = {
  workspaceStatus: ["workspace-status"] as const,
  projects: {
    all: ["projects", "all"] as const,
  },
  projectPage: (projectId: number | null) => ["project-page", projectId] as const,
  workspacePage: ["workspace-page"] as const,
  workspaceTodos: ["workspace-todos"] as const,
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
  search: (query: string) => ["search", query] as const,
} as const;
