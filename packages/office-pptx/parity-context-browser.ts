import {sha256} from '@noble/hashes/sha256';
interface ReplayContext {seed:string;at:number;ordinal:number}
// Every frame owns one session; its IPC queue serializes command and save invocations.
let current:ReplayContext|undefined;
export async function withReplayContext<T>(context:ReplayContext,run:()=>T):Promise<Awaited<T>>{const previous=current;current=context;try{return await run()}finally{current=previous}}
export function replayUUID():string {
 const ctx=current;if(!ctx)return crypto.randomUUID();
 const bytes=sha256(new TextEncoder().encode(`${ctx.seed}:${ctx.ordinal++}`));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Buffer.from(bytes.subarray(0,16)).toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const replayNow=()=>current?.at??Date.now();
export const replayDateISO=()=>new Date(replayNow()).toISOString();
