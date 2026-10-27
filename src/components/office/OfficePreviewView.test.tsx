import {act,render,screen,fireEvent} from '@testing-library/react';
import {useRef,useState} from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {usePreviewView,type OfficePreviewAccess} from '../../../packages/editor-chrome/preview-view';
import {useOfficePreview} from './useOfficePreview';
const owner=window as Window & {__projectMindOfficePreview?:OfficePreviewAccess};
afterEach(()=>{delete owner.__projectMindOfficePreview;vi.unstubAllGlobals();});
it('captures real scroll coordinates and restores slide navigation before zoom',async()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.push(callback);return frames.length;});
 function View(){const [zoom,setZoom]=useState(100),[page,setPage]=useState(0);const scroll=useRef<HTMLDivElement>(null);
  usePreviewView({zoom,setZoom,page,setPage,scrollers:()=>[scroll.current]});
  return <><span>{page}:{zoom}</span><div data-testid="scroll" ref={scroll}/><button onClick={()=>{setZoom(175);setPage(3);}}>navigate</button></>;
 }
 const view=render(<View/>);const scroll=screen.getByTestId('scroll');scroll.scrollTop=630;scroll.scrollLeft=23;fireEvent.click(screen.getByRole('button'));
 const access=owner.__projectMindOfficePreview!;const saved=access.capture();expect(saved).toEqual({zoom:175,page:3,scroll:[{top:630,left:23}]});
 let restoring!:Promise<void>;act(()=>{restoring=access.restore({zoom:140,page:2,scroll:[{top:820,left:50}]});});expect(screen.getByText('2:175')).toBeInTheDocument();
 await act(async()=>frames.shift()!(0));expect(screen.getByText('2:140')).toBeInTheDocument();
 await act(async()=>{frames.shift()!(0);await restoring;});expect(scroll.scrollTop).toBe(820);expect(scroll.scrollLeft).toBe(50);
 view.unmount();expect(owner.__projectMindOfficePreview).toBeUndefined();
});
it('rejects restoration when its frame is disposed, without resurrecting its view',async()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.push(callback);return frames.length;});
 function View(){usePreviewView({zoom:100,setZoom:vi.fn(),scrollers:()=>[]});return null;}
 const view=render(<View/>);const pending=owner.__projectMindOfficePreview!.restore({zoom:120,scroll:[]});view.unmount();frames.shift()!(0);
 await expect(pending).rejects.toThrow('预览已关闭');expect(owner.__projectMindOfficePreview).toBeUndefined();
});
it('surfaces a missing renderer view bridge instead of throwing from the React effect',async()=>{
 vi.useFakeTimers();
 const failed=vi.fn();function Host(){useOfficePreview(true,()=>null,{registerPreview:vi.fn(()=>()=>{})},failed);return null;}
 render(<Host/>);await act(async()=>{await vi.advanceTimersByTimeAsync(600);});expect(failed).toHaveBeenCalledWith('Office 预览视图尚未就绪');
 vi.useRealTimers();
});

it('does not require the eviction bridge for standalone format editor consumers',async()=>{
 const frame=vi.fn(()=>null),failed=vi.fn();function Host(){useOfficePreview(true,frame,{},failed);return null;}
 render(<Host/>);await act(async()=>{});expect(frame).not.toHaveBeenCalled();expect(failed).not.toHaveBeenCalled();
});
