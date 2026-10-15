import type { AgentSourceRef } from '../../../src/lib/agent-types';
import type { ReactElement } from 'react';
export interface DshSessionModel {
  sessionId: string;
  running: boolean;
  model: string | null;
  reasoningEffort?: string;
}
export interface DshConversationHostProps {
  projectId: number | null;
  sessionId: string;
  focused?: boolean;
  onSessionChange?: (id: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onFileOpen?: (path: string, line?: number, sourceRef?: AgentSourceRef) => void;
  onFilesChanged?: () => void;
  onReady?: () => void;
  onError?: (message: string) => void;
  onSettings?: () => void;
  onModelSettings?: () => void;
  onModelChange?: (model: DshSessionModel) => void;
}
export function DshConversationHost(props: DshConversationHostProps): ReactElement;
export function DshSettingsHost(props: { projectId: number | null; mode: 'settings' | 'plugins'; onError?: (message: string) => void }): ReactElement;
export function insertDshFileReference(projectId: number, sessionId: string, path: string, sourceRef?: AgentSourceRef): Promise<void>;
export function disposeDshClients(): Promise<void>;
