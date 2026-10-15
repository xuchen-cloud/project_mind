/** Debug native artifacts also use Vite's production frontend bundle. */
export function resolveDebugBuild(development: boolean, debugArtifact: boolean): boolean {
  return development || debugArtifact;
}

export const isDebugBuild = resolveDebugBuild(import.meta.env.DEV, import.meta.env.PROJECT_MIND_DEBUG_BUILD);
