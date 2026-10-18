import { Buffer } from 'buffer';
export { Buffer };
/** react-reconciler and browserified JSZip utilities consult these Node globals. */
export const process = {env:{NODE_ENV:'production'},platform:'browser',nextTick:(f:()=>void)=>queueMicrotask(f),emit:()=>false};
