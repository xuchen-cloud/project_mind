import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {dshUiAliases} from '../dsh-ui/vite-aliases.mjs';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react(),tailwindcss()],resolve:{alias:dshUiAliases,dedupe:['react','react-dom','@tiptap/core','@tiptap/pm']},server:{port:5197,strictPort:true,watch:{ignored:['**/output/**','**/.playwright-cli/**']},fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}},build:{rollupOptions:{input:fileURLToPath(new URL('preview.html',import.meta.url))}}});
