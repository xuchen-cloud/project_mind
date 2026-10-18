import {readFile} from 'node:fs/promises'
import {extname} from 'node:path'
const dist=new URL('../dist/',import.meta.url)
const types={'.html':'text/html;charset=utf-8','.mjs':'text/javascript;charset=utf-8','.js':'text/javascript;charset=utf-8','.css':'text/css;charset=utf-8','.ttf':'font/ttf','.woff':'font/woff','.woff2':'font/woff2','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}
/** Serve the real renderer tree before each existing test's host document routes. */
export function withRendererResources(handler,{prefix='/'}={}){
 return async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname
  const relative=path.startsWith(prefix)?path.slice(prefix.length):''
  if(relative!=='renderer.html'&&!relative.startsWith('renderer/'))return handler(req,res)
  try{
   const manifest=JSON.parse(await readFile(new URL('renderer-resources.json',dist),'utf8'))
   if(!manifest.files.includes(relative)){res.statusCode=404;res.end('Unknown renderer resource');return}
   res.setHeader('Content-Type',types[extname(relative)]??'application/octet-stream')
   res.end(await readFile(new URL(relative,dist)))
  }catch(error){res.statusCode=500;res.end(String(error))}
 }
}
