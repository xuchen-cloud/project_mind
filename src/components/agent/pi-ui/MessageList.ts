// Adapted from @earendil-works/pi-web-ui 0.75.3. Copyright (c) 2025 Mario Zechner.
// MIT: see LICENSE and UPSTREAM.md. Original result map, ordered items and repeat retained.
import { html, LitElement, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { PiMessage, PiToolResultMessage } from "./types";
import "./Messages";
export class MessageList extends LitElement {
  static properties = { messages: { type: Array }, isStreaming: { type: Boolean }, pendingToolCalls: { type: Object }, externalCallIds: { type: Object } };
  declare messages: PiMessage[];
  declare isStreaming: boolean;
  declare pendingToolCalls?: ReadonlySet<string>;
  declare externalCallIds?: ReadonlySet<string>;
  constructor() { super(); this.messages = []; this.isStreaming = false; }
  protected createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.style.display = "block"; }
  private buildRenderItems() {
    const resultByCallId = new Map<string, PiToolResultMessage>();
    const calls = new Set<string>(this.externalCallIds);
    for (const message of this.messages) {
      if (message.role === "toolResult" && message.toolCallId) resultByCallId.set(message.toolCallId, message);
      if (message.role === "assistant") for (const chunk of message.content) if (chunk.type === "toolCall") calls.add(chunk.id);
    }
    const items: Array<{ key: string; template: TemplateResult }> = [];
    for (const msg of this.messages) {
      if (msg.role === "user") {
        items.push({ key: msg.id, template: html`<pm-pi-user-message .message=${msg}></pm-pi-user-message>` });
      } else if (msg.role === "assistant") {
        items.push({ key: msg.id, template: html`<pm-pi-assistant-message .message=${msg} .isStreaming=${false} .pendingToolCalls=${this.pendingToolCalls} .toolResultsById=${resultByCallId} .hideToolCalls=${false} .hidePendingToolCalls=${this.isStreaming}></pm-pi-assistant-message>` });
      } else if (!msg.toolCallId || !calls.has(msg.toolCallId)) {
        items.push({ key: msg.id, template: html`<pm-pi-orphan-tool-result .result=${msg}></pm-pi-orphan-tool-result>` });
      }
      // Paired results are shown by the corresponding assistant's tool-message.
    }
    return items;
  }
  render() { const items = this.buildRenderItems(); return html`<div class="pi-message-list">${repeat(items, item => item.key, item => item.template)}</div>`; }
}
if (!customElements.get("pm-pi-message-list")) customElements.define("pm-pi-message-list", MessageList);
