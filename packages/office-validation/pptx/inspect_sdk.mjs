import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {importFile, importFileToSnapshot, ExchangeFormat} from '@univerjs-pro/exchange-node';
import {UniverInstanceType} from '@univerjs/core';
const root=new URL('.',import.meta.url); const options={type:UniverInstanceType.UNIVER_SLIDE,format:ExchangeFormat.PPTX};
for(const kind of ['simple','complex']){
 const path=new URL(`${kind}.original.pptx`,root).pathname; let t=performance.now();
 const unit=await importFile(path,options); await fs.writeFile(new URL(`${kind}.imported-unit.json`,root),JSON.stringify(unit,null,2));
 if(kind==='simple') await fs.writeFile(new URL('imported-unit.json',root),JSON.stringify(unit,null,2));
 const summary={kind,unitKeys:Object.keys(unit),importMs:performance.now()-t};
 const strings=[];function walk(v,p=[]){if(typeof v==='string' && !v.startsWith('data:') && v.length<500) strings.push({path:p,value:v}); else if(v&&typeof v==='object') for(const [k,x] of Object.entries(v)) walk(x,[...p,k]);}
 walk(unit); summary.strings=strings.filter(x=>x.value.includes('项目进展')||x.path.some(p=>['pageOrder','slideOrder','elementOrder','elements','transform','image'].includes(p))).slice(0,45);
 console.log(JSON.stringify(summary));
 t=performance.now(); const agg=await importFileToSnapshot(path,options); await fs.writeFile(new URL(`${kind}.aggregate.original.json`,root),JSON.stringify(agg,null,2));
 console.log(JSON.stringify({kind,aggregateKeys:Object.keys(agg),snapshotKeys:Object.keys(agg.snapshot),aggregateImportMs:performance.now()-t,sheetBlocks:agg.sheetBlocks.length}));
}
