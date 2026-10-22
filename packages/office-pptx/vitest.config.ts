import {officeRendererResources} from '../../scripts/office-renderer-resources.mjs';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [officeRendererResources()],
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    'lucide-react': fileURLToPath(new URL('../../node_modules/lucide-react/dist/esm/lucide-react.js', import.meta.url)),
    '@genoffice/docx-engine/math': fileURLToPath(new URL('./vendor/packages/docx-engine/src/math.ts', import.meta.url)),
    '@genoffice/pptx-ops': fileURLToPath(new URL('./vendor/packages/pptx-ops/src/index.ts', import.meta.url)),
  } },
  test: { environment: 'jsdom', include: ['test/*.test.tsx'], maxWorkers: 1, server: { deps: { inline: [/lucide-react/] } } },
});
