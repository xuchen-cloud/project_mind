import { build } from 'esbuild'
await build({entryPoints:['probe.ts'],outfile:'probe.bundle.mjs',bundle:true,
  platform:'node',format:'esm',target:'node24'})
await build({entryPoints:['integration-api.ts'],outfile:'integration.bundle.mjs',bundle:true,
  platform:'node',format:'esm',target:'node24'})
