export function readFaceDir(bytes:Buffer):Array<{offset:number;display:string;famKeys:string[];styleText:string;weight?:number}>;
export function extractFace(bytes:Buffer,offset:number):ArrayBuffer;
