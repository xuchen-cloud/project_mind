import type {AgentWorkspaceBinding} from './agent-types';
import type {FileBytesInput} from './file-types';

export interface EditorRemoteImage {
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
  base64: string;
}
export interface FetchEditorRemoteImageInput {
  binding: AgentWorkspaceBinding;
  document: FileBytesInput;
  url: string;
}
