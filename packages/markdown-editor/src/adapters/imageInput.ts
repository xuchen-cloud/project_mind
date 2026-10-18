export const MARKDOWN_IMAGE_LIMIT=4*1024*1024;
export const imageExtensions={'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp'} as const;
export function firstImage(files:FileList|File[]|null|undefined):File|undefined{return Array.from(files??[]).find(file=>file.type in imageExtensions);}
export function imageMarkdown(src:string,alt:string){const label=alt.replace(/[\\[\]]/gu,'\\$&');const destination=/[\s()<>]/u.test(src)?`<${src.replace(/[<>]/gu,'')}>`:src;return `![${label}](${destination})`;}
/** Only relative references can be delegated to the bound file-resource resolver. */
export function canResolveMarkdownImage(reference:string){return !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/iu.test(reference);}
