import { defineConfig } from "vite";
import { sourceWorkerAssets } from "./scripts/source-worker-assets.mjs";

export default defineConfig({
  plugins: [{ name: "source-worker-notices", async generateBundle(_options, bundle) {
    const { notices, manifest, assets } = await sourceWorkerAssets(bundle);
    for (const asset of assets) this.emitFile(asset);
    this.emitFile({ type: "asset", fileName: "SOURCE-THIRD-PARTY-NOTICES.txt", source: notices });
    this.emitFile({ type: "asset", fileName: "source-worker-distribution.json", source: JSON.stringify(manifest, null, 2) + "\n" });
  } }],
  build: { target: "node24", outDir: "packages/agent-host/source-dist", emptyOutDir: true, minify: false,
    lib: { entry: "src/workers/source-extraction-worker.ts", formats: ["es"], fileName: () => "source-extraction-worker.mjs" },
    rollupOptions: { external: [/^node:/], output: { chunkFileNames: "source-[name]-[hash].mjs" } },
  },
});
