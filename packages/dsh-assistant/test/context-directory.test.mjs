import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeDirectory } from '../scripts/context-directory.mjs';

test('Windows drive and UNC verbatim paths normalize on every host without losing their root',()=>{
 for(const [native,canonical] of [
  [String.raw`\\?\C:\workspace\项目`,String.raw`C:\workspace\项目`],
  [String.raw`\\?\UNC\server\share\项目`,String.raw`\\server\share\项目`],
 ]) {
  assert.equal(normalizeDirectory(native),canonical);
  assert.equal(path.win32.isAbsolute(normalizeDirectory(native)),true);
  assert.equal(normalizeDirectory(canonical),canonical);
  assert.equal(normalizeDirectory(normalizeDirectory(native)),canonical);
 }
 for(const value of [undefined,'/workspace/project','//?/posix',String.raw`\\?\Volume{identity}\project`,String.raw`\\.\pipe\name`]) {
  assert.equal(normalizeDirectory(value),value);
 }
});
