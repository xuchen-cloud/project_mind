import React,{useState} from 'react';
import {afterEach,expect,test,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PDFDocument} from 'pdf-lib';
import {PptxEditor,type PptxModel,type PptxEdit} from '../../../src/components/office/PptxEditor';
import {OfficeEditSession} from '../../../src/lib/office-edit-session';

afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-theme');document.documentElement.classList.remove('dark');vi.restoreAllMocks()});
const model={format:'pptx',sourceBase64:'test'} as PptxModel;
const PlatformChannel=window.MessageChannel;
test('OfficeEditSession cloned parent echoes do not reinitialize the frame or reject its active flush',async()=>{
 const session=new OfficeEditSession<PptxModel,PptxEdit>({object:{workspaceId:'workspace',scope:{kind:'project',projectId:7},kind:'file',id:'42'},versionNumber:1,expectedContentHash:'old'},model,async()=>{throw Error('unused')});
 let flush!:()=>Promise<void>;
 function Parent(){
  const [snapshot,publish]=useState(session.snapshot);
  return <PptxEditor model={snapshot.model} edits={snapshot.edits} readOnly={false} registerBeforeSave={callback=>{flush=callback;return ()=>{}}} onChange={edits=>{session.replaceEdits(edits);publish(session.snapshot)}}/>;
 }
 render(<Parent/>);const frame=screen.getByTitle('PPTX 幻灯片编辑画布') as HTMLIFrameElement;
 let post!:ReturnType<typeof vi.spyOn>;
 vi.spyOn(window,'MessageChannel').mockImplementation(function(){const connection=new PlatformChannel();post=vi.spyOn(connection.port1,'postMessage').mockImplementation(()=>{});return connection});
 const message=(data:object)=>act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{source:'project-mind-pptx',epoch:1,...data}})));
 message({type:'ready'});message({type:'initialized'});
 const waiting=flush();const result=waiting.then(()=> 'flushed',()=> 'rejected');
 const request=post.mock.calls.findLast(c=>c[0].type==='flush')![0];
 const edits=[{kind:'candidate',sourceHash:'old',base64:'candidate',changedParts:['ppt/slides/slide2.xml']}] as PptxEdit[];
 message({type:'change',edits});
 expect(session.snapshot.edits).toEqual(edits);expect(session.snapshot.edits).not.toBe(edits);
 expect(post.mock.calls.filter(c=>c[0].type==='init')).toHaveLength(1);
 message({type:'flushed',requestId:request.requestId});expect(await result).toBe('flushed');
});
function setup(extra:Record<string,unknown>={}){
 const change=vi.fn(),pending=vi.fn();let beforeSave:()=>Promise<void>=async()=>{};
 const props={model,edits:[] as PptxEdit[],onChange:change,readOnly:false,onPendingChange:pending,registerBeforeSave:(callback:()=>Promise<void>)=>{beforeSave=callback;return ()=>{}},...extra};
 const ui=render(<PptxEditor {...props}/>),frame=screen.getByTitle('PPTX 幻灯片编辑画布') as HTMLIFrameElement;
 let post!:ReturnType<typeof vi.spyOn>;vi.spyOn(window,'MessageChannel').mockImplementation(function(){const connection=new PlatformChannel();post=vi.spyOn(connection.port1,'postMessage').mockImplementation(()=>{});return connection});
 const epoch=()=>post?.mock.calls.findLast(c=>c[0].type==='init')?.[0].epoch??0;
 const message=(data:object,source:MessageEventSource|null=frame.contentWindow)=>act(()=>window.dispatchEvent(new MessageEvent('message',{source,data:{source:'project-mind-pptx',epoch:epoch(),...data}})));
 message({type:'ready'});message({type:'initialized'});
 return {...ui,props,frame,post,message,change,pending,epoch,flush:()=>beforeSave()};
}
test('listener setup and iframe load query ready; repeated replies never restart initialization',()=>{
 let send!:ReturnType<typeof vi.spyOn>,post!:ReturnType<typeof vi.spyOn>;
 vi.spyOn(window,'MessageChannel').mockImplementation(function(){const connection=new PlatformChannel();post=vi.spyOn(connection.port1,'postMessage').mockImplementation(()=>{});return connection});
 function Parent(){React.useLayoutEffect(()=>{const frame=screen.getByTitle('PPTX 幻灯片编辑画布') as HTMLIFrameElement;send=vi.spyOn(frame.contentWindow!,'postMessage').mockImplementation(()=>{})},[]);return <PptxEditor model={model} edits={[]} readOnly={false} onChange={()=>{}}/>}
 render(<Parent/>);const frame=screen.getByTitle('PPTX 幻灯片编辑画布') as HTMLIFrameElement;
 expect(send).toHaveBeenCalledWith({source:'project-mind-pptx-host',type:'ready-request'},'*');
 send.mockClear();fireEvent.load(frame);
 expect(send).toHaveBeenCalledWith({source:'project-mind-pptx-host',type:'ready-request'},'*');
 const ready=()=>act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{source:'project-mind-pptx',type:'ready',epoch:0}})));
 ready();ready();ready();
 expect(post.mock.calls.filter(c=>c[0].type==='init')).toHaveLength(1);
});
test('StrictMode cleanup resets readiness and ignores messages from the retired host port',()=>{
 const channels:Array<{port1:MessagePort;port2:MessagePort;send:ReturnType<typeof vi.spyOn>;receive:((event:MessageEvent)=>void)|null}>=[];
 vi.spyOn(window,'MessageChannel').mockImplementation(function(){const connection=new PlatformChannel();const send=vi.spyOn(connection.port1,'postMessage').mockImplementation(()=>{});channels.push({...connection,port1:connection.port1,port2:connection.port2,send,receive:null});return connection});
 const add=window.addEventListener.bind(window);let first=true;
 vi.spyOn(window,'addEventListener').mockImplementation((type,handler,options)=>{
  add(type,handler,options);
  if(type==='message'&&first){first=false;const frame=screen.getByTitle('PPTX 幻灯片编辑画布') as HTMLIFrameElement;window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{source:'project-mind-pptx',type:'ready',epoch:0}}));channels[0].receive=channels[0].port1.onmessage as (event:MessageEvent)=>void;}
 });
 const change=vi.fn();render(<React.StrictMode><PptxEditor model={model} edits={[]} readOnly={false} onChange={change}/></React.StrictMode>);
 const frame=screen.getByTitle('PPTX 幻灯片编辑画布') as HTMLIFrameElement;
 act(()=>window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,data:{source:'project-mind-pptx',type:'ready',epoch:1}})));
 expect(channels).toHaveLength(2);
 const epoch=channels[1].send.mock.calls.find(c=>c[0].type==='init')![0].epoch;expect(epoch).toBe(2);
 act(()=>channels[0].receive?.(new MessageEvent('message',{data:{source:'project-mind-pptx',type:'change',epoch,edits:[]}})));
 expect(change).not.toHaveBeenCalled();
});
test('host accepts editor changes and pending only from its own frame; readOnly crosses the bridge',()=>{
 const ctx=setup();const edits=[{kind:'command',name:'slides:edit-text',args:[]}] as PptxEdit[];
 ctx.message({type:'change',edits},window);expect(ctx.change).not.toHaveBeenCalled();ctx.message({type:'change',edits});expect(ctx.change).toHaveBeenCalledWith(edits);
 ctx.message({type:'pending',pending:true});expect(ctx.pending).toHaveBeenLastCalledWith(true);
 ctx.rerender(<PptxEditor {...ctx.props} readOnly/>);expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'readonly',readOnly:true}));
});
test('beforeSave waits for the renderer, propagates IME rejection and succeeds after commit',async()=>{
 const ctx=setup();let save!:Promise<void>;act(()=>{save=ctx.flush()});let request=ctx.post.mock.calls.at(-1)![0] as {requestId:number};const failure=expect(save).rejects.toThrow('输入');ctx.message({type:'flushed',requestId:request.requestId,error:'请完成输入'});await failure;
 act(()=>{save=ctx.flush()});request=ctx.post.mock.calls.at(-1)![0] as {requestId:number};ctx.message({type:'flushed',requestId:request.requestId});await save;
});
test('model replacement re-initializes through the frame boundary, and flush cannot race initialization',async()=>{
 const ctx=setup();ctx.rerender(<PptxEditor {...ctx.props} model={{...model,sourceBase64:'new'}} edits={[]}/>);
 expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'init',model:expect.objectContaining({sourceBase64:'new'})}));const saved=ctx.flush();ctx.message({type:'initialized'});await act(async()=>{});const req=ctx.post.mock.calls.at(-1)![0] as {requestId:number};ctx.message({type:'flushed',requestId:req.requestId});await saved;
});
test('different edits on the same model replace context and still reject stale epoch messages',()=>{
 const ctx=setup();
 const local=[{kind:'candidate',sourceHash:'old',base64:'local',changedParts:['ppt/slides/slide2.xml']}] as PptxEdit[];
 ctx.message({type:'change',edits:local});const previous=ctx.epoch();
 ctx.rerender(<PptxEditor {...ctx.props} edits={structuredClone(local)}/>);
 expect(ctx.epoch()).toBe(previous);
 const external=[{...local[0],base64:'external'}] as PptxEdit[];
 ctx.rerender(<PptxEditor {...ctx.props} edits={external}/>);
 expect(ctx.epoch()).toBeGreaterThan(previous);ctx.change.mockClear();
 ctx.message({type:'change',epoch:previous,edits:local});expect(ctx.change).not.toHaveBeenCalled();
 expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'init',edits:external}));
});
test('presentation toggles update the same frame without init or invalidating a pending flush',async()=>{
 const ctx=setup({presentationMode:'preview',readOnly:false});
 expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'init',presentationMode:'preview',readOnly:true}));
 const before=ctx.epoch(),count=ctx.post.mock.calls.filter(c=>c[0].type==='init').length;
 const saved=ctx.flush();const request=ctx.post.mock.calls.findLast(c=>c[0].type==='flush')![0];
 ctx.rerender(<PptxEditor {...ctx.props} presentationMode="edit" readOnly={false}/>);
 expect(screen.getByTitle('PPTX 幻灯片编辑画布')).toBe(ctx.frame);
 expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'readonly',presentationMode:'edit',readOnly:false}));
 expect(ctx.epoch()).toBe(before);expect(ctx.post.mock.calls.filter(c=>c[0].type==='init')).toHaveLength(count);
 ctx.message({type:'flushed',requestId:request.requestId});await saved;
 ctx.rerender(<PptxEditor {...ctx.props} presentationMode="preview" readOnly={false}/>);
 expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'readonly',presentationMode:'preview',readOnly:true}));
 expect(ctx.epoch()).toBe(before);
});
test('real app theme and computed font synchronize independently of OS preference',async()=>{
 const ctx=setup();document.documentElement.dataset.theme='dark';document.body.style.fontFamily='Test Host Font';await act(async()=>{});
 expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'theme',theme:'dark',tokens:expect.objectContaining({'--pm-font':expect.stringContaining('Test Host Font')})}));document.body.style.fontFamily='';
});
test('save button awaits host persistence result and closing rejects outstanding flush',async()=>{
 let rejectSave!:(e:Error)=>void;const onSaveRequest=vi.fn(()=>new Promise<void>((_,reject)=>{rejectSave=reject}));const ctx=setup({onSaveRequest});ctx.message({type:'save-request',requestId:12});expect(onSaveRequest).toHaveBeenCalledOnce();await act(async()=>rejectSave(new Error('CAS conflict')));expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'save-finished',requestId:12,error:'CAS conflict'}));const pending=ctx.flush();const failure=expect(pending).rejects.toThrow('关闭');ctx.unmount();await failure;expect(ctx.pending).toHaveBeenLastCalledWith(false);
});

test('internal save commands finish for void callbacks and missing integrations',async()=>{
 const ctx=setup({onSaveRequest:()=>{}});ctx.message({type:'save-request',requestId:21});await act(async()=>{});expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'save-finished',requestId:21}));ctx.unmount();
 const missing=setup();missing.message({type:'save-request',requestId:22});expect(missing.post).toHaveBeenCalledWith(expect.objectContaining({type:'save-finished',requestId:22,error:expect.stringContaining('尚未接入')}));
});

test('native export receives actual bytes, awaits write/cancel and returns errors to the renderer',async()=>{
 let resolve!:(ok:boolean)=>void;const onExport=vi.fn(()=>new Promise<boolean>(r=>{resolve=r}));const ctx=setup({onExport});const file={name:'slides.pdf',mime:'application/pdf',bytes:new Uint8Array([37,80,68,70])};ctx.message({type:'export-request',requestId:41,file});await act(async()=>{});expect(onExport).toHaveBeenCalledWith(file);expect(ctx.post).not.toHaveBeenCalledWith(expect.objectContaining({type:'export-finished',requestId:41}));await act(async()=>resolve(false));expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'export-finished',requestId:41,ok:false}));ctx.message({type:'export-request',requestId:42,file});await act(async()=>{});await act(async()=>resolve(true));expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'export-finished',requestId:42,ok:true}));ctx.unmount();
 const broken=setup({onExport:async()=>{throw new Error('write failed')}});broken.message({type:'export-request',requestId:43,file});await act(async()=>{});expect(broken.post).toHaveBeenCalledWith(expect.objectContaining({type:'export-finished',requestId:43,error:'write failed'}));
});

test('native print waits for the host and reports failure with the same request id',async()=>{
 let reject!:(e:Error)=>void;const onPrint=vi.fn(()=>new Promise<void>((_,r)=>{reject=r}));const ctx=setup({onPrint});const document={html:'<!doctype html><p>打印内容</p>',title:'演示文稿',pageSize:{widthPt:960,heightPt:540}};ctx.message({type:'print-request',requestId:51,document});await act(async()=>{});expect(onPrint).toHaveBeenCalledWith(document);expect(ctx.post).not.toHaveBeenCalledWith(expect.objectContaining({type:'print-finished',requestId:51}));await act(async()=>reject(new Error('print failed')));expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'print-finished',requestId:51,error:'print failed'}));
});

test('native PDF waits for the host and correlates valid returned bytes and rendering failures',async()=>{
 const fixture=await PDFDocument.create();fixture.addPage([960,540]);const bytes=await fixture.save();
 let resolve!:(bytes:Uint8Array)=>void;const onRenderPdf=vi.fn(()=>new Promise<Uint8Array>(r=>{resolve=r}));const ctx=setup({onRenderPdf});const document={html:'<!doctype html><style>@page{size:13.333in 7.5in}</style><svg><text>选中页</text></svg>',title:'selected.pdf',pageSize:{widthPt:960,heightPt:540}};
 ctx.message({type:'render-pdf-request',requestId:61,document});await act(async()=>{});expect(onRenderPdf).toHaveBeenCalledWith(document);expect(ctx.post).not.toHaveBeenCalledWith(expect.objectContaining({type:'render-pdf-finished',requestId:61}));await act(async()=>resolve(bytes));expect(ctx.post).toHaveBeenCalledWith(expect.objectContaining({type:'render-pdf-finished',requestId:61,bytes}));ctx.unmount();
 const failed=setup({onRenderPdf:async()=>{throw new Error('PDF native failed')}});failed.message({type:'render-pdf-request',requestId:62,document});await act(async()=>{});expect(failed.post).toHaveBeenCalledWith(expect.objectContaining({type:'render-pdf-finished',requestId:62,error:'PDF native failed'}));
});

test('old model messages cannot change the new File or release its initialization barrier',async()=>{
 const ctx=setup(),old=ctx.epoch();
 ctx.rerender(<PptxEditor {...ctx.props} model={{...model,sourceBase64:'replacement'}} edits={[]}/>);
 ctx.change.mockClear();ctx.message({type:'change',epoch:old,edits:[{kind:'command',name:'slides:edit-text',args:[]}]});
 expect(ctx.change).not.toHaveBeenCalled();
 const count=()=>ctx.post.mock.calls.filter(c=>c[0].type==='flush').length;
 const before=count();const waiting=ctx.flush();ctx.message({type:'initialized',epoch:old});await act(async()=>{});expect(count()).toBe(before);
 ctx.message({type:'initialized'});await act(async()=>{});expect(count()).toBe(before+1);
 const req=ctx.post.mock.calls.at(-1)![0];ctx.message({type:'flushed',requestId:req.requestId});await waiting;
});

test.each(['export','print','render-pdf'] as const)('late %s result cannot enter the replacement context',async kind=>{
 let finish!:(value:any)=>void;
 const handler=vi.fn(()=>new Promise<any>(r=>{finish=r}));
 const prop=kind==='export'?'onExport':kind==='print'?'onPrint':'onRenderPdf';
 const ctx=setup({[prop]:handler});const old=ctx.epoch();
 ctx.message({type:kind+'-request',requestId:301,file:{name:'old.png',mime:'image/png',bytes:new Uint8Array([1])},document:{html:'<p>old</p>'}});
 await act(async()=>{});expect(handler).toHaveBeenCalledOnce();
 ctx.rerender(<PptxEditor {...ctx.props} model={{...model,sourceBase64:'new context'}} edits={[]}/>);
 ctx.message({type:'initialized'});await act(async()=>finish(kind==='export'?true:kind==='print'?undefined:new Uint8Array([37,80,68,70])));
 expect(ctx.post).not.toHaveBeenCalledWith(expect.objectContaining({type:kind+'-finished',requestId:301}));
 ctx.message({type:kind+'-request',epoch:old,requestId:302});await act(async()=>{});expect(handler).toHaveBeenCalledOnce();
});

test.each(['export','print','render-pdf'] as const)('%s received before replacement cannot call either File callback in a microtask',async kind=>{
 const previous=vi.fn(),next=vi.fn();
 const prop=kind==='export'?'onExport':kind==='print'?'onPrint':'onRenderPdf';
 const ctx=setup({[prop]:previous});
 ctx.message({type:kind+'-request',requestId:401,file:{name:'old'},document:{html:'old'}});
 ctx.rerender(<PptxEditor {...ctx.props} model={{...model,sourceBase64:'replacement'}} edits={[]} {...{[prop]:next}}/>);
 await act(async()=>{});expect(previous).not.toHaveBeenCalled();expect(next).not.toHaveBeenCalled();
 expect(ctx.post).not.toHaveBeenCalledWith(expect.objectContaining({type:kind+'-finished',requestId:401}));
});

test('unmount drops native output completion and replacement rejects an outstanding flush',async()=>{
 let finish!:(value:boolean)=>void;
 const ctx=setup({onExport:()=>new Promise<boolean>(r=>{finish=r})});
 ctx.message({type:'export-request',requestId:501,file:{name:'old'}});await act(async()=>{});
 const pending=ctx.flush(),failed=expect(pending).rejects.toThrow('替换');
 ctx.rerender(<PptxEditor {...ctx.props} model={{...model,sourceBase64:'replacement'}} edits={[]}/>);await failed;
 ctx.unmount();await act(async()=>finish(true));
 expect(ctx.post).not.toHaveBeenCalledWith(expect.objectContaining({type:'export-finished',requestId:501}));
});
