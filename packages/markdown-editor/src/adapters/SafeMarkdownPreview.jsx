// Preserve the existing DSH renderer and its safety rules behind this public React seam.
import { Children, cloneElement, isValidElement, useMemo } from 'react';
import { parseGfmWithMath } from '../../../dsh-ui/upstream/client/ui-primitives/src/markdown/parse.ts';
import { collectReferenceTargets, createReferenceTargets, renderBlocks, renderFootnoteSection, wrapBlockChildren } from '../../../dsh-ui/upstream/client/ui-primitives/src/markdown/render.tsx';
import { CodeBlock } from '../../../dsh-ui/upstream/client/ui-primitives/src/markdown/CodeBlock.tsx';
import css from '../../../dsh-ui/upstream/client/ui-primitives/src/markdown/MarkdownText.module.css';
import { diagramLanguage } from '../genoffice/editor/diagrams';
import { PreviewDiagram } from './PreviewDiagram';
import 'katex/dist/katex.min.css';
import '../../../dsh-ui/styles/scoped.css';
const labels={code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'脚注'};
function diagrams(children) {
  return Children.map(children, child => {
    if (!isValidElement(child)) return child;
    const language=child.type===CodeBlock?diagramLanguage(child.props.lang):null;
    if(language)return <PreviewDiagram key={child.key} language={language} source={child.props.code.slice(0,-1)} fallback={child}/>;
    // DSH keeps empty fences as plain <pre>, which still need a useful error.
    if(child.type==='pre'&&isValidElement(child.props.children)){
      const code=child.props.children;
      const emptyLanguage=diagramLanguage(code.props.className?.replace(/^language-/,''));
      if(emptyLanguage)return <PreviewDiagram key={child.key} language={emptyLanguage} source="" fallback={child}/>;
    }
    return child.props.children===undefined?child:cloneElement(child,undefined,diagrams(child.props.children));
  });
}
export function SafeMarkdownPreview({text,resources}) {
  const pathImages=useMemo(()=>({resolve:path=>resources[path]}),[resources]);
  const children=useMemo(()=>{
    // Same settled DSH pipeline: keep one document-wide reference/footnote
    // context, including diagrams nested inside lists or blockquotes.
    const root=parseGfmWithMath(text),targets=createReferenceTargets();
    collectReferenceTargets(root.children,targets);
    const context={streaming:false,labels,pathImages,targets,footnoteOrder:[],footnoteCounts:new Map()};
    const blocks=wrapBlockChildren(renderBlocks(root.children.map((node,index)=>({node,key:node.position?.start.offset??-(index+1)})),context),false);
    const section=renderFootnoteSection(context);
    return diagrams(section===null?blocks:[...blocks,'\n',section]);
  },[text,pathImages]);
  return <div className="dsh-ui-host"><div className={css.markdown}>{children}</div></div>;
}
