/// <reference types="vite/client" />

declare module '*?office-resource' {
  const url: string;
  export default url;
  export function preload(): () => void;
}

interface ImportMetaEnv {
  readonly PROJECT_MIND_DEBUG_BUILD: boolean;
  readonly OFFICE_PERFORMANCE: boolean;
}
