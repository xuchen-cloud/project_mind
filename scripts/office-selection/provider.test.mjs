import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startSelectionProvider} from './provider.mjs';
test('deterministic provider emits one real DSH tool call from a prepared bound snapshot',async()=>{
 const provider=await startSelectionProvider('native changed');
 try{
  const request=messages=>fetch(provider.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'local-test-model',stream:true,messages,tools:[{type:'function',function:{name:'office_selection_edit'}}]})}).then(r=>r.text());
  const user={role:'user',content:'[office-selection-native]\n<mind-office-selection>{"selectionId":"native-bound-id","format":"docx","text":"old"}</mind-office-selection>'};
  const first=await request([user]);assert.match(first,/office_selection_edit/);assert.match(first,/native-bound-id/);assert.equal(provider.state.result,null);
  const result={saved:false,status:'editor_draft',tracked:true};
  const second=await request([user,{role:'tool',tool_call_id:'native-selection-edit',content:[{type:'text',text:JSON.stringify(result)}]}]);
  assert.doesNotMatch(second,/tool_calls/);assert.deepEqual(provider.state.result,result);assert.equal(provider.state.requests,2);
 }finally{await provider.close()}
});
