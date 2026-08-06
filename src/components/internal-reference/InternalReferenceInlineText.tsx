import { Fragment, useState } from "react";

import {
  buildContactMentionTarget,
  splitContactMentionText,
  type ContactMentionTarget,
} from "../../lib/contactMentions";
import {
  buildInternalReferenceTarget,
  getInternalReferenceKindLabel,
  splitInternalReferenceText,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import { cn } from "../../ui/lib/cn";
import { openTodoUrl, splitTodoUrlText } from "../todo/todo-urls";

export function InternalReferenceInlineText({
  value,
  className,
  onOpenInternalReference,
  onOpenContactMention,
  variant = "default",
}: {
  value: string;
  className?: string;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean;
  variant?: "default" | "todo-inline";
}) {
  const [brokenKeys, setBrokenKeys] = useState<Set<string>>(() => new Set());
  const segments = splitInternalReferenceText(value);

  const markBroken = (key: string, opened: boolean) => {
    setBrokenKeys((current) => {
      const next = new Set(current);
      if (opened) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {segments.map((segment) => {
        if (segment.type === "text") {
          return (
            <Fragment key={`${segment.type}:${segment.text}`}>
              {renderContactMentions(
                segment.text,
                brokenKeys,
                markBroken,
                onOpenContactMention,
                variant === "todo-inline",
              )}
            </Fragment>
          );
        }

        const reference = buildInternalReferenceTarget(segment.reference);
        const broken = brokenKeys.has(segment.key);
        const chipClassName = cn(
          "internal-reference-chip",
          variant === "todo-inline" && "internal-reference-chip--todo",
          broken && "is-broken",
        );

        return (
          <a
            key={segment.key}
            href="#"
            data-type="internal-reference"
            data-ref-kind={reference.refKind}
            data-ref-id={reference.refId}
            data-label={reference.label}
            className={chipClassName}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              if (!onOpenInternalReference) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();

              void Promise.resolve(onOpenInternalReference(reference)).then((opened) => {
                markBroken(segment.key, opened);
              });
            }}
          >
            <span className="internal-reference-chip__kind">
              {getInternalReferenceKindLabel(reference.refKind)}
            </span>
            <span className="internal-reference-chip__label">{reference.label}</span>
          </a>
        );
      })}
    </span>
  );
}

function renderContactMentions(
  text: string,
  brokenKeys: Set<string>,
  markBroken: (key: string, opened: boolean) => void,
  onOpenContactMention?: (mention: ContactMentionTarget) => Promise<boolean> | boolean,
  linkUrls = false,
) {
  const segments = splitContactMentionText(text);

  if (segments.length === 1 && segments[0].type === "text") {
    return linkUrls ? renderTodoUrls(text) : text;
  }

  return segments.map((segment, index) => {
    if (segment.type === "text") {
      return (
        <Fragment key={`mention-text:${index}:${segment.text}`}>
          {linkUrls ? renderTodoUrls(segment.text) : segment.text}
        </Fragment>
      );
    }

    const mention = buildContactMentionTarget(segment.mention);
    const broken = brokenKeys.has(segment.key);

    return (
      <a
        key={segment.key}
        href="#"
        data-type="contact-mention"
        data-contact-id={mention.contactId}
        data-label={mention.label}
        className={cn("contact-mention-chip", broken && "is-broken")}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          if (!onOpenContactMention) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();

          void Promise.resolve(onOpenContactMention(mention)).then((opened) => {
            markBroken(segment.key, opened);
          });
        }}
      >
        <span className="contact-mention-chip__sigil">@</span>
        <span className="contact-mention-chip__label">{mention.label}</span>
      </a>
    );
  });
}

function renderTodoUrls(text: string) {
  return splitTodoUrlText(text).map((segment, index) =>
    segment.type === "text" ? (
      <Fragment key={`url-text:${index}:${segment.text}`}>{segment.text}</Fragment>
    ) : (
      <a
        key={`url:${index}:${segment.href}`}
        href={segment.href}
        className="todo-inline-url"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTodoUrl(segment.href);
        }}
      >
        {segment.text}
      </a>
    ),
  );
}
