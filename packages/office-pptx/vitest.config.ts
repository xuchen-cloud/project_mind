import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    'lucide-react': fileURLToPath(new URL('../../node_modules/lucide-react/dist/esm/lucide-react.js', import.meta.url)),
  } },
  test: { environment: 'jsdom', include: ['test/*.test.tsx'], maxWorkers: 1, server: { deps: { inline: [/lucide-react/] } } },
});
