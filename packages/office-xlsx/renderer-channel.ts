/** A port belongs to one verified iframe handshake and cannot be forged by sibling windows. */
let port:MessagePort|undefined
const listeners=new Set<(data:any)=>void>()
export function connectHostChannel(connection:MessagePort){
 port=connection;connection.onmessage=event=>{if(event.data?.officeXlsx===true)for(const listener of listeners)listener(event.data)};connection.start()
}
export function onHostMessage(listener:(data:any)=>void){listeners.add(listener);return()=>listeners.delete(listener)}
export function sendHostMessage(message:unknown){if(!port)throw Error('Excel 宿主通信尚未就绪');port.postMessage(message)}
