/** Exercise the enclosing File's registered output handler, never iframe globals. */
export async function requestOutput(page,name){
 const command=({'导出 PDF':'pdf','导出图片':'images','导出 HTML':'html','打印…':'print','打印预览':'preview'})[name];
 if(!command)throw Error('Unknown test output action '+name);
 await page.evaluate(command=>{
  const host=window.officeDocxHarness??window.presentation;
  window.outputResult={state:'pending'};
  window.outputPromise=host.output(command).then(()=>{window.outputResult={state:'resolved'};},error=>{window.outputResult={state:'rejected',error:String(error)};});
 },command);
}
