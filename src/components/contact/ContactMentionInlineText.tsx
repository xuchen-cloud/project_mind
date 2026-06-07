import { Fragment, useState } from "react";

import {
  buildContactMentionTarget,
  splitContactMentionText,
  type ContactMentionTarget,
} from "../../lib/contactMentions";
import { cn } from "../../ui/lib/cn";

export function ContactMentionInlineText({
  value,
  className,
  onOpenContactMention,
}: {
  value: string;
  className?: string;
  onOpenContactMention?: (
    mention: ContactMentionTarget,
  ) => Promise<boolean> | boolean;
}) {
  const [brokenKeys, setBrokenKeys] = useState<Set<string>>(() => new Set());
  const segments = splitContactMentionText(value);

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {segments.map((segment) => {
        if (segment.type === "text") {
          return <Fragment key={`${segment.type}:${segment.text}`}>{segment.text}</Fragment>;
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
                setBrokenKeys((current) => {
                  const next = new Set(current);
                  if (opened) {
                    next.delete(segment.key);
                  } else {
                    next.add(segment.key);
                  }
                  return next;
                });
              });
            }}
          >
            <span className="contact-mention-chip__sigil">@</span>
            <span className="contact-mention-chip__label">{mention.label}</span>
          </a>
        );
      })}
    </span>
  );
}
