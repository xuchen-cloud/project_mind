/** SDK list affordances. The grid owns its canvas scrollbars and is excluded. */
export function installScrollMasks(root: HTMLElement) {
  const lists=new Set<HTMLElement>()
  let frame=0
  const measure=()=>{
    frame=0
    for(const node of lists){
      if(!root.contains(node)){sizes.unobserve(node);lists.delete(node);continue}
      const x=Math.max(0,node.scrollWidth-node.clientWidth),y=Math.max(0,node.scrollHeight-node.clientHeight)
      const strength=(distance:number,max:number)=>max?Math.min(1,Math.max(0,distance)/Math.min(64,max/2)):0
      const left=Math.abs(node.scrollLeft)
      node.style.setProperty('--office-mask-left',String(1-strength(left,x)))
      node.style.setProperty('--office-mask-right',String(1-strength(x-left,x)))
      node.style.setProperty('--office-mask-top',String(1-strength(node.scrollTop,y)))
      node.style.setProperty('--office-mask-bottom',String(1-strength(y-node.scrollTop,y)))
      node.dataset.officeScrollMask=x||y?'true':'false'
    }
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure)}
  const sizes=new ResizeObserver(schedule)
  const discover=()=>{
    for(const node of root.querySelectorAll<HTMLElement>('[data-u-comp="ribbon-header-menu"] > div,[data-u-comp="slide-tab-bar"],[data-u-comp="sidebar"] [class*="overflow-y-auto"],[role="listbox"],.ribbon-tabs,.ribbon,.dropdown-menu,.shape-gallery,.icon-gallery,.dialog-body,.pivot-fields-list')){
      if(lists.has(node))continue
      lists.add(node);sizes.observe(node)
      if(node.firstElementChild)sizes.observe(node.firstElementChild)
    }
    schedule()
  }
  const mutations=new MutationObserver(discover)
  mutations.observe(root,{subtree:true,childList:true,characterData:true})
  root.addEventListener('scroll',schedule,true)
  discover()
  return()=>{cancelAnimationFrame(frame);sizes.disconnect();mutations.disconnect();root.removeEventListener('scroll',schedule,true)}
}
