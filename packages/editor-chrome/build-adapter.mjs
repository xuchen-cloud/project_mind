/** Exact pinned JSX seams; fail loudly instead of keeping a second zoom implementation. */
export function replaceStatusZoom(ts,source,path,markup,componentPath) {
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),matches=[];
 const classOf=node=>{
  if(!ts.isJsxElement(node)&&!ts.isJsxSelfClosingElement(node))return '';
  const open=ts.isJsxElement(node)?node.openingElement:node;
  const attr=open.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(ast)==='className');
  return attr?.initializer&&ts.isStringLiteral(attr.initializer)?attr.initializer.text:'';
 };
 function visit(node){if(['zoom-btn','zoom-slider','zoom-value'].includes(classOf(node)))matches.push(node);ts.forEachChild(node,visit)}visit(ast);
 if(matches.length!==4||matches.map(classOf).join(',')!=='zoom-btn,zoom-slider,zoom-btn,zoom-value'||!matches.every(n=>n.parent===matches[0].parent))throw Error('StatusZoom JSX integration changed: '+path);
 return `import {StatusZoom} from ${JSON.stringify(componentPath)};\n`+source.slice(0,matches[0].getStart(ast))+markup+source.slice(matches.at(-1).end);
}

/** Mark only real chrome roots, never the document/paper subtree. */
export function markEditorChrome(ts,source,path) {
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),patches=[];
 function visit(node){
  if(ts.isJsxAttribute(node)&&node.name.getText(ast)==='className'&&node.initializer){
   const init=node.initializer,value=ts.isJsxExpression(init)?init.expression:init;
   const head=value&&(ts.isStringLiteral(value)||ts.isNoSubstitutionTemplateLiteral(value)?value.text:ts.isTemplateExpression(value)?value.head.text:'');
   const hook=head==='status-bar'?'pm-editor-status':/^ribbon(?:\s|$)/.test(head)?'pm-editor-ribbon':/^excel-header(?:\s|$)/.test(head)?'pm-editor-header':null;
   if(hook)patches.push({start:init.getStart(ast),end:init.end,text:init.getText(ast).replace(head,head.replace(/^(\S+)/,`$1 ${hook}`))});
  }
  ts.forEachChild(node,visit);
 }visit(ast);
 for(const p of patches.sort((a,b)=>b.start-a.start))source=source.slice(0,p.start)+p.text+source.slice(p.end);
 return source;
}
