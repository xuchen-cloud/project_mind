import {startLocalProvider} from '../../packages/dsh-assistant/test/fixtures/local-provider.mjs';
/** Local deterministic model; all tool execution remains in the real DSH process. */
export async function startSelectionProvider(marker,format='docx'){
 const state={requests:0,selectionId:null,result:null,error:null,lastRequest:null};let fixture;
 fixture=await startLocalProvider({onSyntheticRequest(body){
  state.requests++;
  const text=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(b=>b.type==='text').map(b=>b.text).join(''):JSON.stringify(value);
  const user=body.messages.findLast(m=>m.role==='user'&&text(m.content).includes('[office-selection-native]'));
  state.lastRequest={tools:body.tools?.map(t=>t.function.name),user:text(user?.content??'').slice(0,2000)};
  const reply=body.messages.findLast(m=>m.role==='tool'&&m.tool_call_id==='native-selection-edit');
  if(reply){try{state.result=JSON.parse(text(reply.content))}catch{state.error=text(reply.content)}return}
  // Background title requests contain a serialized conversation, not a tool turn.
  if(!body.tools?.some(t=>t.function.name==='office_selection_edit'))return;
  const prompt=text(user?.content??'');
  if(!prompt.includes('[office-selection-native]')||state.selectionId)return;
  try{
   // Content arrays arrive as JSON here; parse the original text blocks first.
   const content=user.content;
   const source=typeof content==='string'?content:content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
   const match=source.match(/<mind-office-selection>([\s\S]*?)<\/mind-office-selection>/);if(!match)throw Error('Prepared selection absent from actual provider request');
   const captured=JSON.parse(match[1]);if(captured.format!==format||!captured.selectionId)throw Error('Expected real bound '+format+' selection');
   state.selectionId=captured.selectionId;
   const change=format==='docx'?{text:marker}:format==='xlsx'?{cells:[{row:2,column:1,kind:'number',value:15},{row:3,column:1,kind:'formula',formula:'=B3*2'}]}:{elements:[{id:'e_5',text:marker}]};
   fixture.enqueueResponse({chunks:[''],toolCalls:[{index:0,id:'native-selection-edit',type:'function',function:{name:'office_selection_edit',arguments:JSON.stringify({selection_id:captured.selectionId,change})}}]});
  }catch(error){state.error=String(error)}
 }});
 return {url:fixture.url,state,close:()=>fixture.close()};
}
