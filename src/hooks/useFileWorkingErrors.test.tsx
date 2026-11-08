import {act,renderHook,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useFileWorkingErrors} from './useFileWorkingErrors';
import {desktopApi} from '../services/desktopApi';
import {recordDocumentApi} from '../services/recordDocumentApi';
import {useFeedbackStore} from '../state/feedback-store';
vi.mock('../services/desktopApi',()=>({desktopApi:{listenEvent:vi.fn()}}));
vi.mock('../services/recordDocumentApi',()=>({recordDocumentApi:{bindingGet:vi.fn()}}));
const binding={workspaceId:'w',generation:'g'};
beforeEach(()=>{vi.resetAllMocks();Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{},configurable:true});useFeedbackStore.setState({toasts:[]});vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);});
afterEach(()=>{Reflect.deleteProperty(window,'__TAURI_INTERNALS__');});
it('reports archive failures only for the current Workspace generation, without requiring an open File tab',async()=>{
  let receive!: (event:unknown)=>void;
  const stop=vi.fn();
  vi.mocked(desktopApi.listenEvent).mockImplementation(async(_name,callback)=>{receive=callback;return stop;});
  const view=renderHook(()=>useFileWorkingErrors('/workspace'));
  await waitFor(()=>expect(receive).toBeDefined());
  await act(async()=>receive({binding:{...binding,generation:'old'},error:{message:'old failure'}}));
  expect(useFeedbackStore.getState().toasts).toHaveLength(0);
  await act(async()=>receive({binding,error:{message:'磁盘不可写'}}));
  expect(useFeedbackStore.getState().toasts).toEqual([expect.objectContaining({title:'文件历史归档失败',detail:'磁盘不可写'})]);
  view.unmount();expect(stop).toHaveBeenCalledOnce();
});
it('cleans up a listener that resolves after leaving the Workspace',async()=>{
  let finish!: (stop:()=>void)=>void;const stop=vi.fn();
  vi.mocked(desktopApi.listenEvent).mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  const view=renderHook(()=>useFileWorkingErrors('/workspace'));view.unmount();
  await act(async()=>finish(stop));expect(stop).toHaveBeenCalledOnce();
});
