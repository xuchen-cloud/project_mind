/** Native printing slices the sandbox iframe rather than honouring its @page
 * margins. Prepare physical Markdown pages, keeping real text and SVG nodes. */
export async function paginateMarkdownPrint(html:string,paper:{widthMm:number;heightMm:number}):Promise<string>{
  const frame=document.createElement('iframe');
  frame.title='Markdown 纸面排版';frame.dataset.markdownPagination='preparing';
  frame.setAttribute('sandbox','allow-same-origin');
  frame.style.cssText=`position:fixed;left:-100000px;top:0;width:${paper.widthMm}mm;height:${paper.heightMm}mm;border:0;pointer-events:none`;
  document.body.append(frame);
  try{
    const available=frame.contentDocument;if(!available)throw Error('无法创建 Markdown 纸面排版文档。');
    const doc:Document=available;
    doc.open();doc.write(html.replace('<head>',`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'">`));doc.close();
    const rules=doc.createElement('style');rules.textContent=`
      @page { size:${paper.widthMm}mm ${paper.heightMm}mm; margin:0; }
      html,body { width:${paper.widthMm}mm; margin:0; padding:0; }
      .md-print-page { box-sizing:border-box; break-after:page; }
      .md-print-page:last-child { break-after:auto; }
      .md-print-content { display:flow-root; width:100%; height:100%; overflow-wrap:anywhere; }
      .md-print-content > :first-child { margin-top:0; }
      .md-print-content > :last-child { margin-bottom:0; }
      .md-print-content ol { padding-inline-start:2.5em; }
      .md-print-content img,.md-print-content .md-diagram-preview svg { max-height:${paper.heightMm-44}mm; object-fit:contain; }
    `;doc.head.append(rules);
    // Force font discovery before waiting; all assets were embedded by the caller.
    void doc.body.offsetHeight;
    await Promise.all(Array.from(doc.images,image=>image.decode()));await doc.fonts?.ready;
    const pending=Array.from(doc.body.childNodes).filter(node=>node.nodeType!==3||node.textContent?.trim());
    doc.body.replaceChildren();
    function newPage(){
      const page=doc.createElement('section');page.className='md-print-page';
      page.style.cssText=`width:${paper.widthMm}mm;height:${paper.heightMm}mm;padding:20mm`;
      const area=doc.createElement('div');area.className='md-print-content';page.append(area);doc.body.append(page);return area;
    }
    function fits(area:HTMLElement){return area.scrollHeight<=area.clientHeight+1;}
    type Point={node:Node;offset:number};
    function fragments(node:Element,point:Point){
      const before=doc.createRange();before.selectNodeContents(node);before.setEnd(point.node,point.offset);
      const after=doc.createRange();after.selectNodeContents(node);after.setStart(point.node,point.offset);
      const prefix=node.cloneNode(false) as Element,suffix=node.cloneNode(false) as Element;
      prefix.append(before.cloneContents());suffix.append(after.cloneContents());return {prefix,suffix};
    }
    function split(node:Element,area:HTMLElement):Element{
      const table=node.localName==='table'?node:node.matches('.tableWrapper')?node.querySelector('table'):null;
      node.remove();
      function fitting(point:Point){const {prefix}=fragments(node,point);area.append(prefix);const result=fits(area);prefix.remove();return result;}
      function lastFit(points:Point[]){let low=0,high=points.length;while(low<high){const mid=(low+high)>>>1;if(fitting(points[mid]))low=mid+1;else high=mid;}return low?points[low-1]:undefined;}
      // Prefer complete rows/list items/blocks. Only an over-height block is split
      // within text, preserving its inline marks and ancestor structure.
      const children=table?Array.from(table.querySelectorAll('tr')).filter(row=>!Array.from(row.children).every(cell=>cell.localName==='th')):Array.from(node.children);
      const preferred=children.map(child=>({node:child.parentNode!,offset:Array.from(child.parentNode!.childNodes).indexOf(child)+1}));
      let point=lastFit(preferred);
      if(!point){
        const leaves:{node:ChildNode;start:number;end:number}[]=[];let count=0;
        function visit(parent:Node){for(const child of parent.childNodes){
          if(child.nodeType===3){const size=child.textContent?.length??0;if(size){leaves.push({node:child,start:count,end:count+size});count+=size;}}
          else if(child.nodeType===1&&(child as Element).matches('svg,img,.katex')){leaves.push({node:child,start:count,end:count+1});count++;}
          else visit(child);
        }}visit(node);
        function at(offset:number):Point{const leaf=leaves.find(leaf=>offset<=leaf.end)!;return leaf.node.nodeType===3?{node:leaf.node,offset:offset-leaf.start}:{node:leaf.node.parentNode!,offset:Array.from(leaf.node.parentNode!.childNodes).indexOf(leaf.node)+1};}
        let low=0,high=count;
        while(low<high){const mid=Math.ceil((low+high)/2);if(fitting(at(mid)))low=mid;else high=mid-1;}
        if(low){
          point=at(low);
          if(point.node.nodeType===3){
            const text=point.node.textContent??'';let offset=point.offset;
            // Prefer a nearby word boundary; a long unbroken CJK/code line still wraps.
            const boundary=text.slice(0,offset).search(/\s+\S*$/u);if(boundary>0&&offset-boundary<40)offset=boundary+1;
            if(/[\uDC00-\uDFFF]/u.test(text[offset]??''))offset--;
            point={node:point.node,offset};
          }
        }
      }
      if(!point)throw Error('Markdown 中有无法放入单页正文区域的块。');
      const {prefix,suffix}=fragments(node,point);
      if(node.localName==='ol'){
        const completed=prefix.children.length-(point.node===node?0:1);
        suffix.setAttribute('start',String(Number(node.getAttribute('start')??1)+completed));
      }
      if(table){
        const continued=suffix.localName==='table'?suffix:suffix.querySelector('table');
        if(continued){
          // When one row itself spans sheets, keep empty slots for cells whose
          // content lies in the other fragment, so columns never shift sideways.
          const cutElement=point.node.nodeType===1?point.node as Element:point.node.parentElement;
          const cutCell=cutElement?.closest('td,th'),cutRow=cutCell?.parentElement;
          if(cutCell&&cutRow&&table.contains(cutRow)){
            const cells=Array.from(cutRow.children),index=cells.indexOf(cutCell);
            const preceding=(prefix.localName==='table'?prefix:prefix.querySelector('table'))?.querySelectorAll('tr');
            const beforeRow=preceding?.[preceding.length-1],afterRow=continued.querySelector('tr');
            for(const cell of cells.slice(index+1))beforeRow?.append(cell.cloneNode(false));
            for(const cell of cells.slice(0,index).reverse())afterRow?.prepend(cell.cloneNode(false));
          }
          for(const header of Array.from(table.children).filter(child=>['colgroup','thead'].includes(child.localName)).reverse())if(!continued.querySelector(`:scope > ${header.localName}`))continued.prepend(header.cloneNode(true));
          // Tiptap writes header cells in tbody rather than a thead.
          const first=table.querySelector('tr'),next=continued.querySelector('tr');
          if(first&&next&&Array.from(first.children).every(cell=>cell.localName==='th')&&!Array.from(next.children).every(cell=>cell.localName==='th'))next.before(first.cloneNode(true));
        }
      }
      area.append(prefix);return suffix;
    }
    let area=newPage();
    while(pending.length){
      const node=pending.shift()!,hasContent=area.childNodes.length>0;area.append(node);
      if(fits(area))continue;
      if(hasContent){
        node.remove();const heading=area.lastElementChild;
        if(heading&&/^h[1-6]$/u.test(heading.localName))heading.remove();
        if(area.childNodes.length)area=newPage();
        if(heading&&/^h[1-6]$/u.test(heading.localName))area.append(heading);
        area.append(node);if(fits(area))continue;
      }
      if(node.nodeType!==1)throw Error('Markdown 正文包含无法分页的文本。');
      pending.unshift(split(node as Element,area));area=newPage();
    }
    return '<!doctype html>\n'+doc.documentElement.outerHTML;
  }finally{frame.remove();}
}
