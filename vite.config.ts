import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
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
    port: 1420,
    strictPort: true,
  },
  preview: {
    port: 1420,
    strictPort: true,
  },
  test: {
    exclude: [...configDefaults.exclude, "product-site/**"],
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
