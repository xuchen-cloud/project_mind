import test from 'node:test';
import assert from 'node:assert/strict';
import { handleOfficeRequest } from '../../office-runtime/worker.mjs';
const request = data => ({ requestId: 'office-boundary', method: 'office.inspect', data });
test('Office utility rejects caller paths and external source URLs', async () => {
  const response = await handleOfficeRequest(request({format:'docx', base64:'UEsDBA==', sourcePath:'/private/other-file'}));
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
});
test('Office utility rejects non-canonical source bytes and unsupported binary formats', async () => {
  for (const data of [{format:'docx',base64:'UEsD BA=='}, {format:'doc',base64:'UEsDBA=='}]) {
    const response = await handleOfficeRequest(request(data));
    assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
  }
});
test('Office utility never applies changes through inspection', async () => {
  const response = await handleOfficeRequest(request({format:'xlsx',base64:'UEsDBA==',edits:[]}));
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
});
test('Office editing requires bounded edits', async () => {
  for (const edits of [undefined, Array.from({length:257}, () => ({}))]) {
    const response = await handleOfficeRequest({...request({format:'pptx',base64:'UEsDBA==',edits}),method:'office.edit'});
    assert.equal(response.ok, false); assert.equal(response.error.code, 'INVALID_ARGUMENT');
  }
});
