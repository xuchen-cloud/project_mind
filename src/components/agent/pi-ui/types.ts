import type { AgentJsonValue } from "../../../lib/agent-types";
export type PiContent = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; id: string; name: string; arguments: AgentJsonValue };
export interface PiUserMessage { id: string; role: "user"; content: PiContent[] }
export interface PiAssistantMessage { id: string; role: "assistant"; content: PiContent[]; stopReason?: string }
export interface PiToolResultMessage { id: string; role: "toolResult"; content: PiContent[]; toolCallId?: string; toolName?: string; isError: boolean }
export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;
