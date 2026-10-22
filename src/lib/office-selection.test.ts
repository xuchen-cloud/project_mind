import {expect, it} from 'vitest';
import {officeSelectionError} from './office-selection';
it('keeps native error messages within the UTF-8 byte limit without splitting characters',()=>{
 const error=officeSelectionError(new Error('错😀'.repeat(2000)));
 expect(new TextEncoder().encode(error).length).toBeLessThanOrEqual(4096);
 expect(error).not.toContain('\ufffd');expect(error.length).toBeGreaterThan(1000);
});
