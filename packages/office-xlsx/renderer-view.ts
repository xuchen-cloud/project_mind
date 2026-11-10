import {onHostMessage, sendHostMessage} from './renderer-channel'
import type {OfficeViewRead} from './types'
let nextId = 0, closed = false
const pending = new Map<number, {resolve:(value:unknown)=>void; reject:(error:Error)=>void}>()
onHostMessage(message => {
  if (message.type !== 'readViewReply') return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.value?.error ? request.reject(Error(message.value.error)) : request.resolve(message.value?.result)
})
window.addEventListener('pagehide', () => {
  closed = true
  for (const request of pending.values()) request.reject(Error('Workbook view is closed'))
  pending.clear()
}, {once: true})
export function readView(request: OfficeViewRead): Promise<unknown> {
  if (closed) return Promise.reject(Error('Workbook view is closed'))
  const id = ++nextId
  return new Promise((resolve, reject) => {pending.set(id, {resolve, reject}); sendHostMessage({officeXlsx:true, type:'readViewRequest', value:request, id})})
}
