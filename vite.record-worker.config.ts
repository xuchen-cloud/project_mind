import { defineConfig } from "vite";
import { recordWorkerNoticeAssets } from "./scripts/record-worker-notices.mjs";

export default defineConfig({
  plugins: [{
    name: "record-worker-third-party-notices",
    async generateBundle(_options, bundle) {
      const { notices, manifest } = await recordWorkerNoticeAssets(bundle);
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-NOTICES.txt", source: notices });
      this.emitFile({ type: "asset", fileName: "record-worker-distribution.json", source: JSON.stringify(manifest, null, 2) + "\n" });
    },
  }],
  build: {
    target: "node24",
    outDir: "packages/agent-host/dist",
    emptyOutDir: false,
    minify: false,
    lib: { entry: "src/workers/record-document-worker.ts", formats: ["es"], fileName: () => "record-document-worker.mjs" },
  },
});
