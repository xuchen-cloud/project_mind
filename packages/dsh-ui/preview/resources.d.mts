export function localResourcePath(reference:string):string|undefined;
export function markdownImageReferences(text:string):string[];
export function withResolvedMarkdownImages(text:string,resources:Record<string,string>):string;
