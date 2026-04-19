import { Fragment, useState } from "react";

import {
  buildInternalReferenceTarget,
  getInternalReferenceKindLabel,
  splitInternalReferenceText,
  type InternalReferenceTarget,
} from "../../lib/internalReferences";
import { cn } from "../../ui/lib/cn";

export function InternalReferenceInlineText({
  value,
  className,
  onOpenInternalReference,
  variant = "default",
}: {
  value: string;
  className?: string;
  onOpenInternalReference?: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  variant?: "default" | "todo-inline";
}) {
  const [brokenKeys, setBrokenKeys] = useState<Set<string>>(() => new Set());
  const segments = splitInternalReferenceText(value);

  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {segments.map((segment) => {
        if (segment.type === "text") {
          return <Fragment key={`${segment.type}:${segment.text}`}>{segment.text}</Fragment>;
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
