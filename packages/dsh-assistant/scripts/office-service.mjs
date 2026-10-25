import { defineTool } from '@deepseek-ai/dsh-tools';

// Match the native File SourceRef returned by inspect. An unconstrained JSON
// parameter allowed models to quote the reference, which native cannot parse.
const sourceRefParameter={type:'object',required:true,additionalProperties:false,
  description:'file_office_inspect 返回的完整 sourceRef 对象，直接复制；不要转换为字符串或省略字段。',
  properties:{
    object:{type:'object',required:true,additionalProperties:false,properties:{
      workspaceId:{type:'string',required:true},
      scope:{type:'object',required:true,additionalProperties:false,properties:{
        kind:{type:'string',const:'project',required:true},projectId:{type:'integer',required:true},
      }},
      kind:{type:'string',const:'file',required:true},id:{type:'string',required:true},
    }},
    revision:{type:'string',required:true},fileVersion:{type:'integer',required:true},
    recordVersion:{type:'null',required:true},blockId:{type:'null',required:true},
    locator:{type:'json',required:true},title:{type:'string',required:true},excerpt:{type:'string',required:true},
  }};

// Keep binary assets and renderer trees out of the model-facing projection.
// These views issue the same semantic targets that the shared format SDK edits.
function modelView(model) {
  switch (model.format) {
    case 'docx': return {format:model.format,nodes:model.nodes,readOnly:model.readOnly};
    case 'xlsx': return {format:model.format,sheets:model.sheets.map(({id,name,hidden,veryHidden,rowCount,columnCount})=>({id,name,hidden,...(veryHidden!==undefined?{veryHidden}:{}),rowCount,columnCount})),
      ranges:Object.fromEntries(Object.entries(model.ranges).map(([id,range])=>[id,{area:range.area,cells:range.cells.map(({row,column,value,formula})=>({row,column,value,...(formula!==undefined?{formula}:{})}))}])),definedNames:model.definedNames};
    case 'pptx': return {format:model.format,size:model.size,textElements:model.textElements,pictureElements:model.pictureElements,limitations:model.limitations};
    default: throw new Error('Unsupported native Office model');
  }
}
export async function installOfficeService(ctx,project,bridge) {
  async function owner(exec) {
    const sessionId=exec.agent?.session.id;
    if (!sessionId) throw new Error('Office editing requires an actual Session');
    if(project.forSession){const context=await project.forSession(sessionId,exec.signal);return {sessionId,context};}
    const catalog=await ctx.sessionController.list({cwd:project.directory});
    if (!catalog.items.some(item=>item.sessionId===sessionId&&item.cwd===project.directory)) throw new Error('Office Session belongs to another Project');
    exec.signal.throwIfAborted();
    return {sessionId,context:project};
  }
  const sourceParameter=structuredClone(sourceRefParameter);
  if(project.forSession||project.kind==='workspace') {
    const {required,...projectScope}=sourceParameter.properties.object.properties.scope;
    sourceParameter.properties.object.properties.scope={required,oneOf:[
      {type:'object',additionalProperties:false,properties:{kind:{type:'string',const:'workspace',required:true}}},
      projectScope,
    ]};
  }
  const {required: _required,...inspectSourceParameter}=sourceParameter;
  const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  const disposers=[];
  disposers.push(ctx.tools.register(defineTool({
    name:'file_office_inspect',
    description:'读取当前范围中的 DOCX、XLSX 或 PPTX 文件，返回固定 File 版本与可编辑内容。先调用本工具，再使用返回的 sourceRef 和节点/单元格/文本运行位置调用 file_office_edit。保留图片和原格式部件；此工具不修改文件。',
    parameters:{file_path:{type:'string',description:'相对实际会话目录的路径，或授权范围内绝对路径。Project 会话用项目内路径；Workspace 会话用实际项目目录前缀，自身文件用 files/。与 source_ref 二选一。'},source_ref:inspectSourceParameter},
    output,
    async execute(args,exec) {
      if((args.file_path!==undefined)===(args.source_ref!==undefined))throw new Error('Supply exactly one of file_path or source_ref');
      const {sessionId}=await owner(exec);
      const value=await bridge.request({operation:'officeInspect',sessionId,...(args.source_ref?{sourceRef:args.source_ref}:{path:args.file_path})},exec.signal);
      return {...value,model:modelView(value.model)};
    },
    presentCall:()=>({card:'generic',kind:'read',title:'读取 Office 文件'}),
  })));
  disposers.push(ctx.tools.register(defineTool({
    name:'file_office_edit',
    description:'编辑并保存同一个 Office File，返回真实新版本与保存回执。source_ref 必须使用 file_office_inspect 返回的完整 sourceRef，旧版本/文件变化会拒绝覆盖。DOCX edits: {type:"text",nodeId,text,expectedText?}；XLSX: {sheetId,row,column,kind:"string"|"number"|"formula"|"blank",value?/formula?}，行列零基；PPTX: {kind:"text",slideIndex,cNvPrId,paragraphIndex,runIndex,text} 或 {kind:"move-image",slideIndex,cNvPrId,x,y}。仅简单内容修改，不能改字体、样式、页面结构。',
    parameters:{source_ref:sourceParameter,edits:{type:'array',required:true,items:{type:'json'},description:'格式模块支持的编辑操作，最多 256 项。'}},
    output,
    async execute(args,exec) {
      const {sessionId}=await owner(exec);
      const value=await bridge.request({operation:'officeEdit',sessionId,requestId:String(exec.callId),sourceRef:args.source_ref,edits:args.edits},exec.signal);
      return {...value,...(value.model?{model:modelView(value.model)}:{})};
    },
    presentCall:()=>({card:'generic',kind:'write',title:'保存 Office 文件'}),
  })));
  disposers.push(ctx.tools.register(defineTool({
    name:'file_office_create',
    description:'使用 GenOffice 创建新的 Word DOCX 并保存为原生 File，返回创建回执和固定版本。content 是受限 HTML：h1-h6、p、strong/em/u/s、ul/ol/li、简单 table/tr/th/td、pre、blockquote；不支持图片、CSS、脚本或外部资源。最多 2 MiB。name 是安全的单个 .docx 文件名。已有材料使用 file_office_edit。保持 request_id 和原始参数不变可安全重试。Project 会话默认当前项目；Workspace 会话省略 project_id 创建 Workspace File，或用已查询的实际 Project ID。',
    parameters:{name:{type:'string',required:true},content:{type:'string',required:true},request_id:{type:'string',required:true},project_id:{type:'integer'}},output,
    async execute(args,exec){
      const {sessionId,context}=await owner(exec);
      const policy=ctx.get('sandboxPolicy')?.resolve({session:exec.agent.session});
      if(!policy||!['workspace-write','danger-full-access'].includes(policy.mode))throw new Error('当前会话为只读，不能创建 Office 文件');
      if(policy.workspaceRoot!==context.directory)throw new Error('Office creation policy belongs to another context');
      // Observe the committed result even when Stop races the native commit.
      const value=await bridge.request({operation:'officeCreate',sessionId,requestId:args.request_id,mode:policy.mode,projectId:args.project_id??null,name:args.name,content:args.content});
      return {...value,...(value.model?{model:modelView(value.model)}:{})};
    },
    presentCall:()=>({card:'generic',kind:'write',title:'创建 Word 文件'}),
  })));
  ctx.effect(()=>()=>disposers.forEach(dispose=>dispose()));
}
