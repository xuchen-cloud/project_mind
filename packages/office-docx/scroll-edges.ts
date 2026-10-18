/** Continuous scroll affordances for the upstream canvas, ribbon and bounded panels. */
export function installScrollEdges(){
 const selectors='.pm-status-info,.ribbon-tabs,.ribbon-body,.rb-font-size-menu,.rb-font-family-menu,.cover-gallery,.shape-palette,.equation-gallery,.equation-preview,.layout-menu-scroll,.style-gallery-menu,.styles-pane-list,.editor-scroll,.nav-body,.comments-pane-list,.pv-scroll,.bookmark-list,.modal-shortcuts .sc-list,.protect-dialog,.print-options,.find-results,.split-pane-scroll,.ctx-submenu-scroll,.list-dialog-symbols,.list-define-levels,.table-style-gallery,.table-properties-dialog,.rb-shape-gallery';
 const areas=new Map<HTMLElement,HTMLElement[]>();let scheduled=0;
 const axis=(total:number,visible:number,offset:number)=>{const max=Math.max(0,total-visible),p=Math.min(max,Math.max(0,offset)),d=Math.min(64,max/2);return d?[Math.min(1,p/d),Math.min(1,(max-p)/d)]:[0,0];};
 function measure(node:HTMLElement,edges:HTMLElement[]){
  const rect=node.getBoundingClientRect(),style=getComputedStyle(node),[top,bottom]=axis(node.scrollHeight,node.clientHeight,node.scrollTop),[left,right]=axis(node.scrollWidth,node.clientWidth,node.scrollLeft);
  const visible=node.isConnected&&rect.width>0&&rect.height>0&&style.visibility!=='hidden';
  let z=1;for(let parent:HTMLElement|null=node;parent;parent=parent.parentElement){const value=Number.parseInt(getComputedStyle(parent).zIndex);if(Number.isFinite(value))z=Math.max(z,value+1);}
  let bg=style.backgroundColor;for(let parent=node.parentElement;parent&&bg==='rgba(0, 0, 0, 0)';parent=parent.parentElement)bg=getComputedStyle(parent).backgroundColor;
  const width=Math.max(0,node.clientWidth),height=Math.max(0,node.clientHeight);
  const positions=[{left:rect.left,top:rect.top,width,height:Math.min(24,height*.35)},{left:rect.left,top:rect.top+height-Math.min(24,height*.35),width,height:Math.min(24,height*.35)},{left:rect.left,top:rect.top,width:Math.min(16,width*.35),height},{left:rect.left+width-Math.min(16,width*.35),top:rect.top,width:Math.min(16,width*.35),height}];
  for(let i=0;i<4;i++){
   const edge=edges[i],position=positions[i],opacity=visible?[top,bottom,left,right][i]:0;
   const value=`position:fixed;pointer-events:none;z-index:${z};left:${position.left}px;top:${position.top}px;width:${position.width}px;height:${position.height}px;opacity:${opacity};background:linear-gradient(to ${['bottom','top','right','left'][i]},${bg},transparent)`;
   if(edge.style.cssText!==value)edge.style.cssText=value;
   edge.dataset.opacity=String(opacity);
  }
 }
 function update(){scheduled=0;
  for(const node of document.querySelectorAll<HTMLElement>(selectors))if(!areas.has(node)){
   const edges=['top','bottom','left','right'].map(side=>{const edge=document.createElement('div');edge.className=`office-docx-scroll-edge office-docx-scroll-edge--${side}`;edge.setAttribute('aria-hidden','true');document.body.append(edge);return edge;});
   areas.set(node,edges);observer.observe(node);
  }
  for(const [node,edges] of areas)if(!node.isConnected){edges.forEach(edge=>edge.remove());areas.delete(node);observer.unobserve(node);}else{for(const child of node.children)observer.observe(child);measure(node,edges);}
 }
 const schedule=()=>{if(!scheduled)scheduled=requestAnimationFrame(update);};
 const observer=new ResizeObserver(schedule);
 const mutations=new MutationObserver(records=>{if(records.some(record=>!(record.target instanceof Element&&record.target.closest('.office-docx-scroll-edge'))))schedule();});
 mutations.observe(document.body,{childList:true,subtree:true,characterData:true});
 document.addEventListener('scroll',event=>{if(event.target instanceof HTMLElement){const edges=areas.get(event.target);if(edges)measure(event.target,edges);}},true);
 window.addEventListener('resize',schedule);schedule();
 return()=>{mutations.disconnect();observer.disconnect();cancelAnimationFrame(scheduled);for(const edges of areas.values())edges.forEach(edge=>edge.remove());};
}
