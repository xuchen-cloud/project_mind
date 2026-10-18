import { sha256 } from '@noble/hashes/sha256';
import { zlibSync } from 'fflate';
import { Buffer } from 'buffer';
export { Buffer };
export const createHash = (algorithm:string) => {
  if(algorithm!=='sha256')throw new Error(`Unsupported browser hash: ${algorithm}`);
  const h=sha256.create();return {update(bytes:Uint8Array){h.update(bytes);return this},digest(format:string){if(format!=='hex')throw new Error('Unsupported digest');return Buffer.from(h.digest()).toString('hex')}};
};
export const randomUUID = () => crypto.randomUUID();
export const deflateSync = (data:Uint8Array) => Buffer.from(zlibSync(data));
// Native file persistence is owned by Project Mind; renderer code only calls savePptx(bytes).
export function createWriteStream():never {throw new Error('Native save belongs to the Project Mind host')}
export async function pipeline():Promise<never> {throw new Error('Native save belongs to the Project Mind host')}
