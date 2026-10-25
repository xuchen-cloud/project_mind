import {readFile} from 'node:fs/promises';
import JSZip from 'jszip';
export async function complexAuthoringContent(){
  const source=await JSZip.loadAsync(await readFile(new URL('complex.original.docx',import.meta.url)));
  const image=Object.keys(source.files).find(p=>/^word\/media\/.*\.png$/.test(p));
  const png=await source.file(image).async('base64');
  return {html:'<h1>季度经营报告</h1><p>复杂排版正文：营收增长与成本控制。</p><table><tr><th>业务</th><th>金额</th></tr><tr><td>研发</td><td>120</td></tr><tr><td>销售</td><td>160</td></tr></table><p>表后说明</p>',ops:[
    {op:'setFont',target:{blockIndexes:[0,1,2,3]},fontSize:12,fontFamily:'宋体'},
    {op:'setFont',target:{nodeType:'docHeading'},fontSize:26,bold:true,color:'#17365D'},
    {op:'setParagraphFormat',target:{nodeType:'docHeading'},align:'center',spaceAfter:240},
    {op:'setParagraphFormat',target:{nodeType:'docParagraph'},lineSpacing:1.5,spaceAfter:120},
    {op:'setTableCellFormat',target:{nodeType:'table'},range:{row:0,col:0,colEnd:1},fill:'#D9E2F3',vAlign:'center'},
    {op:'mergeTableCells',target:{nodeType:'table'},range:{row:2,col:0,colEnd:1}},
    {op:'set_page_setup',paper:'A4',margins:{top:'2cm',bottom:'2cm',left:'2cm',right:'2cm'}},
    {op:'set_header_footer',kind:'header',text:'内部经营分析 · 2026'},
    {op:'set_header_footer',kind:'footer',text:'第 {PAGE} 页 / 共 {NUMPAGES} 页'},
    {op:'insert_picture',url:'data:image/png;base64,'+png,width:'2cm',altText:'项目标识'},
    {op:'insert_chart',kind:'bar',title:'季度业务收入',categories:['研发','销售'],series:[{name:'收入',values:[120,160]}]},
  ]};
}
