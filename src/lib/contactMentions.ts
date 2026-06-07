import type { ContactRecord } from "./types";

export interface ContactMentionTarget {
  contactId: number;
  label: string;
}

export type ContactMentionTextSegment =
  | { type: "text"; text: string }
  | {
      type: "mention";
      token: string;
      key: string;
      mention: ContactMentionTarget;
    };

export interface ContactMentionTextTrigger {
  start: number;
  end: number;
  query: string;
}

const CONTACT_MENTION_TRIGGER_TOKENS = ["@", "＠"] as const;
const CONTACT_MENTION_LABEL_MAX_CHARS = 24;

// `@[contact:12|张三]` — distinct delimiters from the `[[note:...]]` family so
// the two reference systems never collide in a single plaintext stream.
const CONTACT_MENTION_TOKEN_PATTERN = /@\[contact:(\d+)\|([^[\]\r\n]+?)\]/gu;
const CONTACT_MENTION_EMBEDDED_TOKEN_PATTERN = /@\[contact:\d+\|[^[\]\r\n]+?\]/gu;
const CONTACT_MENTION_SELECTOR = "[data-type='contact-mention']";

export function buildContactMentionToken(mention: ContactMentionTarget) {
  return `@[contact:${mention.contactId}|${sanitizeContactMentionLabel(mention.label)}]`;
}

export function buildContactMentionTarget(
  mention: ContactMentionTarget | Pick<ContactRecord, "id" | "name">,
): ContactMentionTarget {
  if ("contactId" in mention) {
    return {
      contactId: mention.contactId,
      label: sanitizeContactMentionLabel(mention.label),
    };
  }

  return {
    contactId: mention.id,
    label: sanitizeContactMentionLabel(mention.name),
  };
}

export function splitContactMentionText(source: string): ContactMentionTextSegment[] {
  const segments: ContactMentionTextSegment[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(CONTACT_MENTION_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    const contactId = Number(match[1]);
    const label = sanitizeContactMentionLabel(match[2]);

    if (index > lastIndex) {
      segments.push({ type: "text", text: source.slice(lastIndex, index) });
    }

    segments.push({
      type: "mention",
      token,
      key: `contact:${contactId}:${index}`,
      mention: { contactId, label },
    });
    lastIndex = index + token.length;
  }

  if (lastIndex < source.length) {
    segments.push({ type: "text", text: source.slice(lastIndex) });
  }

  return segments;
}

export function findContactMentionTextTrigger(
  source: string,
  caretPosition: number | null | undefined,
): ContactMentionTextTrigger | null {
  if (
    typeof caretPosition !== "number" ||
    caretPosition < 0 ||
    caretPosition > source.length
  ) {
    return null;
  }

  const beforeCaret = source.slice(0, caretPosition);
  let start = -1;
  let triggerToken: (typeof CONTACT_MENTION_TRIGGER_TOKENS)[number] | null = null;

  for (const token of CONTACT_MENTION_TRIGGER_TOKENS) {
    const candidateStart = beforeCaret.lastIndexOf(token);

    if (candidateStart > start) {
      start = candidateStart;
      triggerToken = token;
    }
  }

  if (start < 0 || !triggerToken) {
    return null;
  }

  // Only treat `@` as a mention trigger when it starts a word: either at the
  // very beginning or after whitespace. This avoids hijacking email addresses
  // and other inline `@` usage.
  if (start > 0) {
    const charBefore = beforeCaret[start - 1];
    if (!/\s/u.test(charBefore)) {
      return null;
    }
  }

  const query = beforeCaret.slice(start + triggerToken.length);

  // A mention query is a single run of non-whitespace; whitespace, newlines or
  // a closing bracket means the user moved past the mention.
  if (/[\s\r\n\]]/u.test(query)) {
    return null;
  }

  return { start, end: caretPosition, query };
}

export function buildContactMentionHtml(mention: ContactMentionTarget) {
  const normalized = buildContactMentionTarget(mention);

  return [
    `<span data-type="contact-mention"`,
    ` data-contact-id="${normalized.contactId}"`,
    ` data-label="${escapeHtml(normalized.label)}"`,
    ` class="contact-mention-chip"`,
    ` role="link"`,
    ` aria-label="${escapeHtml(`联系人 ${normalized.label}`)}"`,
    ` contenteditable="false">`,
    `<span class="contact-mention-chip__sigil">@</span>`,
    `<span class="contact-mention-chip__label">${escapeHtml(normalized.label)}</span>`,
    `</span>`,
  ].join("");
}

export function findContactMentionElement(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>(CONTACT_MENTION_SELECTOR)
    : null;
}

export function readContactMentionElement(
  element: HTMLElement | null | undefined,
): ContactMentionTarget | null {
  if (!element) {
    return null;
  }

  const contactId = Number(element.dataset.contactId);

  if (!Number.isInteger(contactId) || contactId <= 0) {
    return null;
  }

  return {
    contactId,
    label: sanitizeContactMentionLabel(element.dataset.label ?? ""),
  };
}

export function setContactMentionElementBroken(
  element: HTMLElement | null | undefined,
  broken: boolean,
) {
  element?.classList.toggle("is-broken", broken);
}

function sanitizeContactMentionLabel(label: string) {
  const normalized = label
    .replace(CONTACT_MENTION_EMBEDDED_TOKEN_PATTERN, " ")
    .replace(/[|\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const resolved = normalized || "未命名联系人";

  const characters = Array.from(resolved);
  if (characters.length <= CONTACT_MENTION_LABEL_MAX_CHARS) {
    return resolved;
  }
  return `${characters.slice(0, CONTACT_MENTION_LABEL_MAX_CHARS).join("")}...`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
