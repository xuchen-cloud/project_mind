import { zlibSync } from 'fflate';
import { buf } from 'crc-32';
// The two node:zlib calls in upstream page-settings' 1×1 background PNG.
export default { deflateSync: zlibSync, crc32: (bytes: Uint8Array) => buf(bytes) >>> 0 };
