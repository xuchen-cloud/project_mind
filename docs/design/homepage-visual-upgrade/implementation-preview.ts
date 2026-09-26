// Isolated visual acceptance fixture. No commands reach a real Workspace database.
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from '../../../src/lib/richTextStyle';
import { desktopApi } from '../../../src/services/desktopApi';
const time = '2026-09-26T09:00:00Z';
const tags = [{id:1,label:'工作方法',colorKey:'blue',usageCount:3,createdAt:time,updatedAt:time},{id:2,label:'灵感',colorKey:'amber',usageCount:1,createdAt:time,updatedAt:time},{id:3,label:'待读',colorKey:'teal',usageCount:0,createdAt:time,updatedAt:time}];
const projects = ['品牌视觉升级','秋季阅读计划','产品设计手记'].map((name,i)=>({id:i+1,name,kind:'normal',status:'active',rootPath:`/tmp/homepage-qa/project-${i+1}`,quickNote:'记下今天的灵感，稍后再整理。',quickNoteMarkdown:'记下今天的灵感，稍后再整理。',quickNoteHtml:'<p>记下今天的灵感，稍后再整理。</p>',isArchived:false,createdAt:time,updatedAt:time,openTodoCount:2}));
const records = ['好的界面让人专注于内容','把零散灵感变成持续积累','一周回顾：保持清晰的工作节奏','阅读摘录与实践'].map((title,i)=>({id:i+1,projectId:1,title,contentMarkdown:'设计的价值在于帮助人们清晰思考。保留足够的留白，把需要的工具放在自然的位置，让记录与行动在同一个上下文中连接起来。',contentHtml:'<p>设计的价值在于帮助人们清晰思考。保留足够的留白，把需要的工具放在自然的位置，让记录与行动在同一个上下文中连接起来。</p>',tags:[tags[i%2]],defaultCodeLanguage:null,createdAt:time,updatedAt:time}));
const workspaceRecords = records.map((record) => ({ ...record }));
const projectRecords = new Map(projects.map(project => [project.id, records.map(record => ({ ...record, projectId: project.id }))]));
let quickNote = {id:50,title:null,contentMarkdown:'每一个想法，都值得被认真记下。\n\n今天想继续梳理项目首页的细节。 #灵感',contentHtml:'<p>每一个想法，都值得被认真记下。</p><p>今天想继续梳理项目首页的细节。 #灵感</p>',tags:[],createdAt:time,updatedAt:time};
const todos = ['整理设计参考','确认首页交互细节','记录本周的收获'].map((content,i)=>({id:i+1,scope:i?'project':'workspace',projectId:i?1:null,projectName:i?projects[0].name:null,content,status:'unfinished',priority:'not_urgent_important',createdAt:time,updatedAt:time,progresses:[],tags:[]}));
const workspace={rootPath:'/tmp/homepage-qa',displayName:'我的工作区'};
const previewCommand = async (name: string, payload?: Record<string, unknown>): Promise<unknown> => {
 const input:any = payload?.input ?? {};
 if(name==='workspace_status_get') return {currentWorkspace:workspace,recentWorkspaces:[],aiSecretsUnlocked:true};
 if(name==='projects_list') return projects;
 if(name==='workspace_page_get') return {quickNote:{...quickNote},records:[...workspaceRecords],unfinishedTodos:todos,finishedTodos:[]};
 if(name==='project_page_get') return {project:projects.find(p=>p.id===input.projectId)||projects[0],records:[...(projectRecords.get(input.projectId) ?? [])],projectDocuments:[],unfinishedTodos:todos.filter(t=>t.projectId),finishedTodos:[]};
 if(name==='file_tag_settings_get') return {tags};
 if(name==='workspace_quick_note_upsert'){quickNote={...quickNote,contentMarkdown:input.markdown,contentHtml:input.html};return quickNote;}
 if(name==='project_update'){const p=projects.find(p=>p.id===input.projectId)!;Object.assign(p,input);return p;}
 if (['workspace_quick_note_commit', 'project_quick_note_commit', 'workspace_record_upsert', 'project_record_upsert'].includes(name)) {
   const collection = name.startsWith('workspace') ? workspaceRecords : projectRecords.get(input.projectId) ?? [];
   const id = input.recordId ?? input.noteId;
   const index = collection.findIndex(record => record.id === id);
   const record = { ...collection[0], id: id ?? Math.max(0, ...collection.map(record => record.id)) + 1, title: input.title, contentMarkdown: input.markdown, contentHtml: input.html, tags: tags.filter(tag => input.tagIds?.includes(tag.id)), updatedAt: new Date().toISOString() };
   if (index >= 0) collection[index] = record; else collection.unshift(record);
   if (name === 'workspace_quick_note_commit') quickNote = { ...quickNote, contentMarkdown: '', contentHtml: '<p></p>' };
   if (name === 'project_quick_note_commit') Object.assign(projects.find(p => p.id === input.projectId)!, {quickNote:'',quickNoteMarkdown:'',quickNoteHtml:'<p></p>'});
   return record;
 }
 if(name==='ai_settings_get') return null;
 if(name==='voice_snapshot_get') return null;
 if(name==='rich_text_style_get') return DEFAULT_RICH_TEXT_STYLE_SETTINGS;
 if(name==='workspace_todos_list') return todos;
 if(name==='project_todos_list') return todos.filter(t=>t.projectId);
 if(name.endsWith('_list')||name.endsWith('_search')) return [];
 if(name==='file_tag_option_upsert') return tags.find(t=>t.label===input.label)||tags[0];
 return {};
};
desktopApi.command = async <T>(name: string, payload?: Record<string, unknown>) => await previewCommand(name, payload) as T;
await import('../../../src/main');
