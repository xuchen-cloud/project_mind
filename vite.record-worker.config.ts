import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node24",
    outDir: "packages/agent-host/dist",
    emptyOutDir: false,
    minify: false,
    lib: { entry: "src/workers/record-document-worker.ts", formats: ["es"], fileName: () => "record-document-worker.mjs" },
  },
});
