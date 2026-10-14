import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { dshUiAliases } from './packages/dsh-ui/vite-aliases.mjs';

export default defineConfig({
  define: { "import.meta.env.PROJECT_MIND_DEBUG_BUILD": process.env.TAURI_ENV_DEBUG === "true" },
  resolve: { alias: dshUiAliases, dedupe: ['react', 'react-dom'] },
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { main: "index.html", voice: "voice.html" },
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            // Shared static file artwork is reused by the host and lazy DSH UI.
            if (/\/packages\/dsh-ui\/upstream\/client\/ui-primitives\/src\/(?:FileTypeIcon|CodeFileIcon|code-file-icon-artwork|code-file-types)/u.test(id)) {
              return "file-icons";
            }
            if (
              id.includes("/src/components/rich-editor/") &&
              !/(ImageAnnotationDialog|image-annotations|imageThumbnails)/u.test(id)
            ) {
              return "rich-editor";
            }
            return undefined;
          }

          // Keep the annotation canvas inside its dynamic import graph. Assigning
          // Konva to a manual vendor chunk causes Rollup to preload it at startup.
          if (id.includes("react-konva") || id.includes("/konva/")) {
            return undefined;
          }

          if (
            id.includes("@tiptap/") ||
            id.includes("/prosemirror-") ||
            id.includes("/orderedmap/")
          ) {
            return "editor";
          }

          if (id.includes("react-router") || id.includes("@remix-run/router")) {
            return "router";
          }

          if (id.includes("@tanstack/react-query")) {
            return "query";
          }

          if (id.includes("@tauri-apps/")) {
            return "tauri";
          }

          if (id.includes("/react/") || id.includes("/react-dom/")) {
            return "react-vendor";
          }

          return "vendor";
        },
      },
    },
  },
  server: {
    // File-provider backed worktrees can miss native filesystem events.
    watch: {
      usePolling: true,
      interval: 300,
      // Backend staging and fixtures contain HTML/JS but are not browser inputs.
      // Watching them reloads the main UI during native and runtime verification.
      ignored: ["**/src-tauri/**", "**/packages/dsh-assistant/**", "**/*.test.*"],
    },
    port: 1420,
    strictPort: true,
  },
  preview: {
    port: 1420,
    strictPort: true,
  },
  test: {
    // Bound concurrent jsdom/editor/PDF work to avoid CPU-starvation timeouts.
    maxWorkers: 4,
    // Backend packages own their Node test runner and must not load jsdom.
    exclude: [
      ...configDefaults.exclude,
      "product-site/**",
      "packages/agent-host/**",
      "packages/dsh-assistant/**",
      "packages/dsh-ui/upstream/**",
      // These files use node:test and file:// APIs, not Vitest/jsdom.
      "scripts/desktop-runtime.test.mjs",
      "scripts/stage-dsh-runtime.test.mjs",
      "scripts/prepare-cli.test.mjs",
      "packages/dsh-ui/vendor-integrity.test.mjs",
      "packages/dsh-ui/preview/assets-integrity.test.mjs",
    ],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    environmentOptions: {
      jsdom: {
        url: "http://localhost/",
      },
    },
  },
});
