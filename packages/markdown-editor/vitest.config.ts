import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { dshUiAliases } from '../dsh-ui/vite-aliases.mjs';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: dshUiAliases, dedupe: ['react', 'react-dom'] },
  test: { environment: 'jsdom', css:{include:[/katex/]}, include: ['tests/**/*.test.{ts,tsx}'], setupFiles: ['./tests/setup.ts'], maxWorkers: 1 },
});
