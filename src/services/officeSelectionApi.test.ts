import {beforeEach, expect, it, vi} from 'vitest';
import {officeSelectionApi} from './officeSelectionApi';
import {callAgentCommand} from './agentApi';
import {desktopApi} from './desktopApi';
vi.mock('./agentApi',()=>({callAgentCommand:vi.fn()}));
vi.mock('./desktopApi',()=>({desktopApi:{listenEvent:vi.fn()}}));
beforeEach(()=>vi.clearAllMocks());
it('uses bound native envelopes and keeps the tool attempt ID inside receipt data',async()=>{
 const binding={workspaceId:'w',generation:'g'},receipt={editorId:'editor',selectionId:'selection',requestId:'attempt'};
 await officeSelectionApi.claim(binding,receipt);await officeSelectionApi.reply(binding,{...receipt,text:'changed'});
 for(const [command,requestId,args] of vi.mocked(callAgentCommand).mock.calls){expect(['office_selection_claim','office_selection_reply']).toContain(command);expect(requestId).not.toBe('attempt');expect(args).toEqual({input:{binding,requestId,data:expect.objectContaining(receipt)}});}
});
it('listens to the native window event without replacing its scoped payload',async()=>{
 const callback=vi.fn();await officeSelectionApi.listen(callback);expect(desktopApi.listenEvent).toHaveBeenCalledExactlyOnceWith('mind:office-selection-edit',callback);
});
