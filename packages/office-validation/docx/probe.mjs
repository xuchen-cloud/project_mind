import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importBuffer, importBufferToSnapshot, ExchangeFormat } from '@univerjs-pro/exchange-node';
import { UniverInstanceType } from '@univerjs/core';
const root=path.dirname(fileURLToPath(import.meta.url));
const opts={type:UniverInstanceType.UNIVER_DOC, format:ExchangeFormat.DOCX,fileName:'simple.original.docx'};
const input=await fs.readFile(path.join(root,opts.fileName));
for (const [name,fn] of [['unit',importBuffer],['aggregate',importBufferToSnapshot]]) {
 const t=performance.now(); const value=await fn(input,opts);
 await fs.writeFile(path.join(root,`simple.imported-${name}.json`),JSON.stringify(value,null,2));
 if(name==='unit') await fs.writeFile(path.join(root,'imported-unit.json'),JSON.stringify(value,null,2));
 console.log(JSON.stringify({kind:name,ms:performance.now()-t,keys:Object.keys(value),bodyKeys:Object.keys(value.body??{}),bodyDataStream:value.body?.dataStream,tableKeys:Object.keys(value.tableSource??{}),drawingKeys:Object.keys(value.drawings??{}),aggregateKeys:Object.keys(value.snapshot??{})}));
}
