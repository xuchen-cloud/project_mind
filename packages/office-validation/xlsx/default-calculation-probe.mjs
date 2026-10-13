import fs from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {UniverInstanceType} from '@univerjs/core';
import {ExchangeFormat,exportToBuffer,importBuffer} from '@univerjs-pro/exchange-node';
const start=performance.now();
const unit=JSON.parse(await fs.readFile(new URL('simple.unit.edited.json',import.meta.url),'utf8'));
const opts={type:UniverInstanceType.UNIVER_SHEET,format:ExchangeFormat.XLSX};
// Deliberately omit formulaCalculation to test the documented WHEN_EMPTY default.
const buffer=await exportToBuffer(unit,opts);
await fs.writeFile(new URL('simple.unit.edited-default.xlsx',import.meta.url),buffer);
const reimported=await importBuffer(buffer,{...opts,fileName:'simple.unit.edited-default.xlsx'});
await fs.writeFile(new URL('simple.unit.edited-default.reimported.json',import.meta.url),JSON.stringify(reimported,null,2));
await fs.writeFile(new URL('default-calculation-sdk.json',import.meta.url),JSON.stringify({node:process.version,ms:performance.now()-start,options:opts},null,2));
console.log(JSON.stringify({node:process.version,ms:performance.now()-start,options:opts}));
