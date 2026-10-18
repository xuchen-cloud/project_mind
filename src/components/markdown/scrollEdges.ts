/** Continuous distance-driven edge opacity; observers also handle content/viewport changes. */
export function watchEdges(viewport:HTMLElement,frame:HTMLElement):()=>void {
  const measure=()=>{
    for(const [axis,pos,max] of [['y',viewport.scrollTop,Math.max(0,viewport.scrollHeight-viewport.clientHeight)],['x',viewport.scrollLeft,Math.max(0,viewport.scrollWidth-viewport.clientWidth)]] as const){
      const distance=Math.min(64,max/2),offset=Math.max(0,Math.min(max,pos));
      frame.style.setProperty(`--md-${axis}-start`,String(distance?Math.min(1,offset/distance):0));
      frame.style.setProperty(`--md-${axis}-end`,String(distance?Math.min(1,(max-offset)/distance):0));
    }
    frame.style.setProperty('--md-scrollbar-height',`${Math.max(0,viewport.offsetHeight-viewport.clientHeight)}px`);
    frame.style.setProperty('--md-scrollbar-width',`${Math.max(0,viewport.offsetWidth-viewport.clientWidth)}px`);
  };
  measure();viewport.addEventListener('scroll',measure,{passive:true});
  const resize=new ResizeObserver(measure);resize.observe(viewport);if(viewport.firstElementChild)resize.observe(viewport.firstElementChild);
  const mutation=new MutationObserver(measure);mutation.observe(viewport,{childList:true,characterData:true,subtree:true});
  return()=>{viewport.removeEventListener('scroll',measure);resize.disconnect();mutation.disconnect();};
}
