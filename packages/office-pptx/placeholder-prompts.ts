import type {RenderSlide} from './vendor/packages/pptx-render/src/render-tree';
/** Filled slides retain real empty placeholders without drawing editor hints over their content. */
export function suppressFilledSlidePrompts(slide:RenderSlide):RenderSlide{
 const content=slide.nodes.some(node=>!node.background&&!('placeholder' in node&&node.placeholder)&&(
  !['shape','text'].includes(node.type)||'text' in node&&node.text?.lines.some(line=>line.runs.some(run=>run.text.trim()))||'fill' in node&&node.fill&&node.fill.kind!=='none'||'stroke' in node&&node.stroke
 ));
 if(content)for(const node of slide.nodes)if('placeholder' in node&&node.placeholder)Object.assign(node,{projectMindSuppressPrompt:true});
 return slide;
}
