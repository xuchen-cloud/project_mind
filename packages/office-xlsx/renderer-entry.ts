import {initialize} from './renderer-host'
void initialize().then(()=>import('./vendor/apps/sheets/src/renderer/main')).catch(error=>parent.postMessage({officeXlsx:true,type:'error',value:String(error.message??error)},'*'))
