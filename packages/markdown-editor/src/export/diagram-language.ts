// The fixed upstream DOCX mapper only needs language identification, not renderer side effects.
export type DiagramLanguage='mermaid'|'wavedrom';
export function diagramLanguage(value:unknown):DiagramLanguage|null{return value==='mermaid'||value==='wavedrom'?value:null;}
