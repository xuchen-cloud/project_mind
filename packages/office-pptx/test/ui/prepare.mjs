import { readFile, writeFile } from 'node:fs/promises';
import { inspect } from '../../dist/engine.mjs';
const bytes = await readFile(new URL('../fixtures/complex.pptx', import.meta.url));
await writeFile(new URL('./model.json', import.meta.url), JSON.stringify(await inspect(bytes)));
