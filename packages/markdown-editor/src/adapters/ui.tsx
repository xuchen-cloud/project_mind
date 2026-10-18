import type { ReactNode } from 'react';
import { HomeSidebarList } from '../../../../src/components/home/HomeSidebarList';
import type { FindOptions } from './find-text';
export {findInText, type FindOptions} from './find-text';
export interface FindTarget {
  readonly editable: boolean;
  search(query:string, options:FindOptions, activeIndex:number):number;
  activate(index:number):void;
  replaceOne(index:number,replacement:string):void;
  replaceAll(replacement:string):void;
  clear():void;
  onDocChanged(listener:()=>void):()=>void;
}
export function Dropdown<T extends string>({value,options,onPick,disabled,className}:{value:T;options:{value:T;label:string}[];onPick:(value:T)=>void;disabled?:boolean;className?:string}) {
  return <select aria-label="代码语言" className={className} value={value} disabled={disabled} onChange={event=>onPick(event.target.value as T)}>{options.map(option=><option value={option.value} key={option.value}>{option.label}</option>)}</select>;
}
export function installPopoverDismiss(close:()=>void,{inside}:{inside:()=>Array<HTMLElement|null>}) {
  const press=(event:Event)=>{if(!inside().some(element=>element?.contains(event.target as Node)))close();};
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};
  document.addEventListener('pointerdown',press,true); document.addEventListener('keydown',key); window.addEventListener('blur',close);
  return ()=>{document.removeEventListener('pointerdown',press,true);document.removeEventListener('keydown',key);window.removeEventListener('blur',close);};
}

export function ScrollMenu({children,label='插入块'}:{children:ReactNode;label?:string}) { return <HomeSidebarList label={label}>{children}</HomeSidebarList>; }
