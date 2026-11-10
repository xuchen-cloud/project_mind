// The fixed upstream DOCX mapper only needs language identification, not renderer side effects.
export type DiagramLanguage='mermaid';
export function diagramLanguage(value:unknown):DiagramLanguage|null{return value==='mermaid'?value:null;}
