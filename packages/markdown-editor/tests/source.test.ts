import {expect,it} from 'vitest';
import {applySourceEdits,mergeRenderedSource} from '../src/source';
it('keeps untouched mixed EOL/BOM/trailing spaces around actual source edits',()=>{
 const original='\uFEFFfirst\r\nsecond  \nthird\r\n';
 expect(applySourceEdits(original,[{from:7,to:13,insert:'修改'}])).toBe('\uFEFFfirst\r\n修改  \nthird\r\n');
 expect(mergeRenderedSource(original,'\uFEFFfirst\nsecond changed  \nthird\n')).toBe('\uFEFFfirst\r\nsecond changed  \nthird\r\n');
 expect(mergeRenderedSource(original,original.replaceAll('\r\n','\n'))).toBe(original);
});
