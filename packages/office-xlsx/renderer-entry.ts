import {initialize} from './renderer-host'
import {sendHostMessage} from './renderer-channel'
performance.mark('office-xlsx:entry')
let connected=false
void initialize().then(()=>{
 connected=true
 performance.mark('office-xlsx:host-initialized')
 performance.mark('office-xlsx:main-import-start')
 return import('./vendor/apps/sheets/src/renderer/main')
}).then(()=>performance.mark('office-xlsx:main-import-end')).catch(error=>{
 const message={officeXlsx:true,type:'error',value:String(error.message??error)}
 if(connected)sendHostMessage(message)
 else parent.postMessage(message,'*')
})
