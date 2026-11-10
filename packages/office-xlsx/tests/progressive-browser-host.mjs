import {mount} from '/browser.mjs'
const json = async (url, value) => {
  const response = await fetch(url, value === undefined ? {} : {method:'POST', body:JSON.stringify(value)})
  if (!response.ok) throw Error(await response.text())
  return response.json()
}
const model = await json('/model')
const state = window.xlsxAcceptance = {model, edits:[], editRevision:0, savedEditRevision:0, pending:false, errors:[], presentationMode:'edit'}
document.querySelector('#editor').addEventListener('office-error', event => state.errors.push(event.detail))
function props() {
  return {model:state.model, edits:state.edits, savedEditRevision:state.savedEditRevision, readOnly:false, presentationMode:state.presentationMode,
    onChange(edits, snapshot) {state.edits = edits; state.editRevision = snapshot.editRevision; state.editor.update(props())},
    onPendingChange(value) {state.pending = value},
    onReadView: request => json('/read', request),
    onRecalculate: request => json('/calculate', request),
    onSaveRequest: () => state.save(),
  }
}
state.editor = mount(document.querySelector('#editor'), props(), '/renderer.html')
state.ready = state.editor.ready.then(() => {state.readyAt = performance.timeOrigin + performance.now()})
state.save = async () => {
  await state.editor.commitEditing()
  const receipt = await json('/save', {edits:state.edits, editRevision:state.editRevision})
  state.savedEditRevision = receipt.editRevision
  state.editor.update(props())
}
state.preview = value => {state.presentationMode = value ? 'preview' : 'edit'; state.editor.update(props())}
state.reopen = async () => {
  state.editor.dispose()
  state.model = await json('/reopen', {})
  state.edits = []; state.editRevision = 0; state.savedEditRevision = 0
  state.editor = mount(document.querySelector('#editor'), props(), '/renderer.html')
  await state.editor.ready
}
