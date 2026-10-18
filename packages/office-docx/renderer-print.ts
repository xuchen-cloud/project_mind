/** Preserve upstream's selected, measured print sheets; no application controls. */
export async function buildPrintDocument(title:string):Promise<{html:string;title:string;pageSize:{widthPt:number;heightPt:number}}>{
  const preview=document.querySelector<HTMLElement>('.pagination-preview');
  const sheets=[...preview?.querySelectorAll<HTMLElement>('.pv-page:not(.pv-print-skip)')??[]];
  if(!sheets.length)throw Error('没有已分页的可打印页面。');
  await document.fonts.ready;
  const usedFonts=new Set<string>();
  const characters=new Set<number>();
  for(const sheet of sheets)for(const element of [sheet,...sheet.querySelectorAll('*')]){
    for(const font of getComputedStyle(element).fontFamily.split(','))usedFonts.add(font.trim().replace(/^['"]|['"]$/g,'').toLowerCase());
    for(const child of element.childNodes)if(child.nodeType===Node.TEXT_NODE)for(const character of child.textContent??'')characters.add(character.codePointAt(0)!);
  }
  const resources=new Map<string,Promise<string>>();
  const embed=(url:string,font=false):Promise<string>=>{
    if(font)url=(window as any).__projectMindWordPrintFonts?.get(url)??url;
    if(url.startsWith('data:')||url.startsWith('#'))return Promise.resolve(url);
    const key=(font?'font:':'image:')+url;
    if(!resources.has(key))resources.set(key,(async()=>{
      let response:Response;
      try{response=await fetch(url);}catch{throw Error(`打印资源无法内嵌：${url}`);}
      if(!response.ok)throw Error(`打印资源无法内嵌：${url} (${response.status})`);
      const blob=await response.blob();
      const bytes=new Uint8Array(await blob.arrayBuffer());
      const signature=String.fromCharCode(...bytes.subarray(0,4));
      const mime=font?(signature==='wOF2'?'font/woff2':signature==='wOFF'?'font/woff':signature==='OTTO'?'font/otf':'font/ttf'):blob.type;
      if(!font&&!mime.startsWith('image/'))throw Error(`打印资源不是可内嵌图片：${url} (${mime})`);
      let value='';
      for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));
      return`data:${mime};base64,${btoa(value)}`;
    })());
    return resources.get(key)!;
  };
  const inlineCss=async(css:string,font=false)=>{
    if(/@import\b/i.test(css))throw Error('打印样式包含未内嵌的 @import。');
    const urls=[...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)];
    for(const match of urls){const url=(match[1]??match[2]??match[3]).trim();css=css.replace(match[0],`url("${await embed(url,font)}")`);}
    return css;
  };
  const styles:string[]=[];
  const printRegularFamilies=new Set<string>(),printBoldFamilies=new Set<string>();
  const loadedFonts=[...document.fonts].filter(face=>face.status==='loaded');
  const familyName=(name:string)=>name.trim().replace(/^['"]|['"]$/g,'').toLowerCase();
  const weight=(value:string)=>value==='normal'||!value?'400':value==='bold'?'700':value;
  const range=(value:string)=>value.replace(/\s/g,'').toUpperCase();
  for(const sheet of document.styleSheets){
    let rules:CSSRuleList;try{rules=sheet.cssRules;}catch{throw Error(`打印样式无法内嵌：${sheet.href}`);}
    for(const rule of rules){
      const font=rule.type===CSSRule.FONT_FACE_RULE;
      if(font){
        const descriptor=(rule as CSSFontFaceRule).style;
        if(!usedFonts.has(familyName(descriptor.fontFamily)))continue;
        const unicodeRange=descriptor.getPropertyValue('unicode-range');
        if(unicodeRange&&!unicodeRange.split(',').some(value=>{
          const match=value.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
          if(!match)return true;
          const from=parseInt(match[1].replace(/\?/g,'0'),16),to=parseInt(match[2]??match[1].replace(/\?/g,'F'),16);
          return[...characters].some(character=>character>=from&&character<=to);
        }))continue;
        // Only faces the current renderer actually loaded can have contributed
        // to these measured sheets. Unused fallback aliases/ranges otherwise
        // expand a small document into tens of MiB of duplicated font data.
        if(!loadedFonts.some(face=>familyName(face.family)===familyName(descriptor.fontFamily)&&weight(face.weight)===weight(descriptor.fontWeight)&&face.style===(descriptor.fontStyle||'normal')&&range(face.unicodeRange)===range(descriptor.getPropertyValue('unicode-range')||'U+0-10FFFF')))continue;
        const urls=[...descriptor.getPropertyValue('src').matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)];
        if(urls.some(match=>(window as any).__projectMindWordPrintFonts?.has((match[1]??match[2]??match[3]).trim()))){
          (Number(weight(descriptor.fontWeight))>=600?printBoldFamilies:printRegularFamilies).add(familyName(descriptor.fontFamily));
        }
      }
      styles.push(await inlineCss(rule.cssText,font));
    }
  }
  const container=document.createElement('div');container.className='pagination-preview';
  const pages=document.createElement('div');pages.className='pv-scroll';container.append(pages);
  const geometry:string[]=[];
  for(const [i,sheet]of sheets.entries()){
    const copy=sheet.cloneNode(true) as HTMLElement;
    const sourceNodes=[sheet,...sheet.querySelectorAll('*')];
    const original=new Map([copy,...copy.querySelectorAll('*')].map((node,index)=>[node,sourceNodes[index]]));
    // Input/selection widgets are never print content. The pagination clone
    // already contains upstream's body, headers, notes, markup and drawings.
    for(const element of copy.querySelectorAll('script,noscript,button,input,textarea,select,iframe,object,embed,.pv-pageno,.img-resize-handle,.doc-move-handle,.ProseMirror-gapcursor,img.ProseMirror-separator'))element.remove();
    for(const element of [copy,...copy.querySelectorAll('*')]){
      for(const attribute of [...element.attributes]){
        if(/^on/i.test(attribute.name)||['contenteditable','tabindex','autofocus','srcdoc','inert'].includes(attribute.name))element.removeAttribute(attribute.name);
      }
      if(element instanceof HTMLCanvasElement)throw Error('打印页面包含尚未转换为图片的 Canvas。');
      if(element instanceof HTMLImageElement){element.removeAttribute('srcset');element.src=await embed(element.currentSrc||element.src);}
      if(element instanceof SVGImageElement){const href=element.getAttribute('href')??element.getAttribute('xlink:href');if(href)element.setAttribute('href',await embed(href));element.removeAttribute('xlink:href');}
      if(element.tagName.toLowerCase()==='a'){element.removeAttribute('href');element.removeAttribute('xlink:href');}
      // WK prints a synthesized bold Regular CJK face by drawing its text four
      // times, which duplicates selectable/copyable words. Keep the original
      // advance widths and bold appearance with one fill+stroke operation on
      // the print clone. Real bold faces and the live screen DOM are unchanged.
      if(element instanceof HTMLElement&&[...element.childNodes].some(node=>node.nodeType===Node.TEXT_NODE&&/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(node.textContent??''))){
        const style=getComputedStyle(original.get(element)!);
        if(Number(weight(style.fontWeight))>=600&&style.fontFamily.split(',').some(name=>printRegularFamilies.has(familyName(name))&&!printBoldFamilies.has(familyName(name)))){
          element.style.fontSynthesis='style';
          element.style.setProperty('-webkit-text-stroke','0.01em currentColor');
        }
      }
      if(element.hasAttribute('style'))element.setAttribute('style',await inlineCss(element.getAttribute('style')!));
    }
    const width=sheet.offsetWidth,height=sheet.offsetHeight;
    copy.dataset.nativePage=String(i);pages.append(copy);
    geometry.push(`@page pmWord${i}{size:${width}px ${height}px;margin:0}[data-native-page="${i}"]{page:pmWord${i}}`);
  }
  // Native print is measured at scale 1; preserve the pre-sliced page geometry
  // without the original device-pixel compensation from Electron's print API.
  const reset='html,body{margin:0!important;padding:0!important;height:auto!important;overflow:visible!important}.pagination-preview{position:static!important;display:block!important;zoom:1!important}.pv-scroll{display:block!important;padding:0!important;overflow:visible!important}.pv-page{margin:0!important;box-shadow:none!important}.pv-page:last-child{break-after:auto!important}*{animation:none!important;transition:none!important}';
  const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const width=parseFloat(sheets[0].style.width),height=parseFloat(sheets[0].style.height);
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw Error('选中打印页的纸张尺寸无效。');
  return{title,pageSize:{widthPt:Math.round(width*15)/20,heightPt:Math.round(height*15)/20},html:`<!doctype html><html lang="${document.documentElement.lang||'zh-CN'}" data-theme="light" data-doc-theme="light"><head><meta charset="utf-8"><title>${escape(title)}</title><style>${styles.join('\n').replace(/<\/style/gi,'<\\/style')}\n${geometry.join('\n')}\n${reset}</style></head><body>${container.outerHTML}</body></html>`};
}
