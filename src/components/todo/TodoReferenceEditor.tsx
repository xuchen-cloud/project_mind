import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ClipboardEventHandler,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type MutableRefObject,
  type MouseEventHandler,
} from "react";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  getInternalReferenceKindLabel,
  readInternalReferenceElement,
  splitInternalReferenceText,
} from "../../lib/internalReferences";
import { cn } from "../../ui/lib/cn";

interface TodoReferenceEditorProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "className" | "contentEditable" | "onChange"> {
  value: string;
  editorRef: MutableRefObject<HTMLDivElement | null>;
  selectionOffset?: number | null;
  containerClassName?: string;
  textClassName: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (nextValue: string, selectionOffset: number | null) => void;
  onSelectionChange?: (selectionOffset: number | null) => void;
}

export function TodoReferenceEditor({
  value,
  editorRef,
  selectionOffset,
  containerClassName,
  textClassName,
  placeholder,
  disabled = false,
  autoFocus = false,
  onChange,
  onSelectionChange,
  onBlur,
  onFocus,
  onKeyDown,
  onKeyUp,
  onClick,
  onMouseUp,
  ...props
}: TodoReferenceEditorProps) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const didAutoFocusRef = useRef(false);

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      editorRef.current = node;
    },
    [editorRef],
  );

  useLayoutEffect(() => {
    const root = localRef.current;

    if (!root) {
      return;
    }

    const active = document.activeElement === root;
    const currentValue = serializeTodoReferenceEditorValue(root);

    if (currentValue !== value) {
      renderTodoReferenceEditorValue(root, value);
    }

    if (autoFocus && !didAutoFocusRef.current && !disabled) {
      root.focus();
      setTodoReferenceEditorSelection(root, selectionOffset ?? value.length);
      didAutoFocusRef.current = true;
      return;
    }

    if (active && typeof selectionOffset === "number") {
      const currentSelection = getTodoReferenceEditorSelection(root);

      if (currentSelection !== selectionOffset) {
        setTodoReferenceEditorSelection(root, selectionOffset);
      }
    }
  }, [autoFocus, disabled, selectionOffset, value]);

  const emitSelection = useCallback(() => {
    const root = localRef.current;

    if (!root) {
      onSelectionChange?.(null);
      return;
    }

    onSelectionChange?.(getTodoReferenceEditorSelection(root));
  }, [onSelectionChange]);

  const handleInput = useCallback(() => {
    const root = localRef.current;

    if (!root) {
      return;
    }

    const nextValue = serializeTodoReferenceEditorValue(root);
    const nextSelection = getTodoReferenceEditorSelection(root);

    onChange(nextValue, nextSelection);
  }, [onChange]);

  const handlePaste: ClipboardEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }

      event.preventDefault();

      const rawText = event.clipboardData.getData("text/plain");
      const normalizedText = normalizeTodoReferenceEditorText(rawText);

      if (!normalizedText) {
        return;
      }

      insertTextIntoTodoReferenceEditor(normalizedText);
      handleInput();
    },
    [disabled, handleInput],
  );

  const handleFocus = useCallback<NonNullable<HTMLAttributes<HTMLDivElement>["onFocus"]>>(
    (event) => {
      emitSelection();
      onFocus?.(event);
    },
    [emitSelection, onFocus],
  );

  const handleClick = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      emitSelection();
      onClick?.(event);
    },
    [emitSelection, onClick],
  );

  const handleMouseUp = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      emitSelection();
      onMouseUp?.(event);
    },
    [emitSelection, onMouseUp],
  );

  const handleKeyUp = useCallback<KeyboardEventHandler<HTMLDivElement>>(
    (event) => {
      emitSelection();
      onKeyUp?.(event);
    },
    [emitSelection, onKeyUp],
  );

  return (
    <div
      className={cn(
        "todo-editor-field relative",
        disabled && "opacity-75",
        containerClassName,
      )}
    >
      {placeholder && value.length === 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 text-text-soft",
            textClassName,
          )}
        >
          {placeholder}
        </span>
      ) : null}
      <div
        {...props}
        ref={handleRef}
        role="textbox"
        aria-multiline="false"
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={cn(
          "w-full text-text outline-none whitespace-pre-wrap break-words",
          textClassName,
          disabled && "cursor-default",
        )}
        onInput={handleInput}
        onPaste={handlePaste}
        onFocus={handleFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onKeyUp={handleKeyUp}
        onClick={handleClick}
        onMouseUp={handleMouseUp}
      />
    </div>
  );
}

function renderTodoReferenceEditorValue(root: HTMLDivElement, value: string) {
  root.replaceChildren(
    ...splitInternalReferenceText(value).map((segment) => {
      if (segment.type === "text") {
        return document.createTextNode(segment.text);
      }

      const reference = buildInternalReferenceTarget(segment.reference);
      const chip = document.createElement("span");
      const kind = document.createElement("span");
      const label = document.createElement("span");

      chip.dataset.type = "internal-reference";
      chip.dataset.refKind = reference.refKind;
      chip.dataset.refId = String(reference.refId);
      chip.dataset.label = reference.label;
      chip.className = "internal-reference-chip internal-reference-chip--todo";
      chip.contentEditable = "false";

      kind.className = "internal-reference-chip__kind";
      kind.textContent = getInternalReferenceKindLabel(reference.refKind);

      label.className = "internal-reference-chip__label";
      label.textContent = reference.label;

      chip.append(kind, label);
      return chip;
    }),
  );
}

function serializeTodoReferenceEditorValue(root: HTMLDivElement) {
  return normalizeTodoReferenceEditorText(serializeTodoReferenceNode(root));
}

function serializeTodoReferenceNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeTodoReferenceEditorText(node.textContent ?? "");
  }

  if (node instanceof HTMLElement) {
    const reference = readInternalReferenceElement(node);

    if (reference) {
      return buildInternalReferenceToken(reference);
    }

    if (node.tagName === "BR") {
      return " ";
    }

    return Array.from(node.childNodes)
      .map((child) => serializeTodoReferenceNode(child))
      .join("");
  }

  return "";
}

function normalizeTodoReferenceEditorText(value: string) {
  return value.replace(/\u00a0/gu, " ").replace(/\r?\n+/gu, " ");
}

function getTodoReferenceEditorSelection(root: HTMLDivElement) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);

  if (!root.contains(range.startContainer) && range.startContainer !== root) {
    return null;
  }

  return getSerializedOffset(root, range.startContainer, range.startOffset);
}

function getSerializedOffset(root: Node, targetNode: Node, targetOffset: number): number | null {
  let total = 0;
  let found = false;

  const walk = (node: Node) => {
    if (found) {
      return;
    }

    if (node === targetNode) {
      total += getPartialSerializedLength(node, targetOffset);
      found = true;
      return;
    }

    total += getSerializedLength(node);
  };

  const visit = (node: Node) => {
    if (found) {
      return;
    }

    if (node === targetNode) {
      walk(node);
      return;
    }

    if (isSerializedAtomicNode(node) || node.nodeType === Node.TEXT_NODE) {
      walk(node);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }

    for (const child of Array.from(node.childNodes)) {
      visit(child);
      if (found) {
        return;
      }
    }
  };

  visit(root);

  return found ? total : null;
}

function getPartialSerializedLength(node: Node, offset: number) {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeTodoReferenceEditorText(node.textContent?.slice(0, offset) ?? "").length;
  }

  if (node instanceof HTMLElement) {
    const reference = readInternalReferenceElement(node);

    if (reference) {
      return offset > 0 ? buildInternalReferenceToken(reference).length : 0;
    }

    return Array.from(node.childNodes)
      .slice(0, offset)
      .reduce((total, child) => total + getSerializedLength(child), 0);
  }

  return 0;
}

function getSerializedLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeTodoReferenceEditorText(node.textContent ?? "").length;
  }

  if (node instanceof HTMLElement) {
    const reference = readInternalReferenceElement(node);

    if (reference) {
      return buildInternalReferenceToken(reference).length;
    }

    if (node.tagName === "BR") {
      return 1;
    }

    return Array.from(node.childNodes).reduce((total, child) => total + getSerializedLength(child), 0);
  }

  return 0;
}

function isSerializedAtomicNode(node: Node) {
  return node instanceof HTMLElement && Boolean(readInternalReferenceElement(node));
}

export function setTodoReferenceEditorSelection(root: HTMLDivElement, targetOffset: number) {
  const selection = window.getSelection();

  if (!selection) {
    return;
  }

  const { node, offset } = findSelectionPoint(root, Math.max(0, targetOffset));
  const range = document.createRange();

  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function findSelectionPoint(root: HTMLDivElement, targetOffset: number) {
  const point = resolveSelectionPoint(root, targetOffset);

  return point ?? { node: root, offset: root.childNodes.length };
}

function resolveSelectionPoint(
  node: Node,
  remaining: number,
): { node: Node; offset: number; remaining: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const length = normalizeTodoReferenceEditorText(node.textContent ?? "").length;

    if (remaining <= length) {
      return { node, offset: remaining, remaining: 0 };
    }

    return { node, offset: length, remaining: remaining - length };
  }

  if (node instanceof HTMLElement) {
    const reference = readInternalReferenceElement(node);

    if (reference) {
      const tokenLength = buildInternalReferenceToken(reference).length;
      const parent = node.parentNode;

      if (!parent) {
        return null;
      }

      const index = Array.prototype.indexOf.call(parent.childNodes, node);

      if (remaining <= 0) {
        return { node: parent, offset: index, remaining: 0 };
      }

      if (remaining <= tokenLength) {
        return { node: parent, offset: index + 1, remaining: 0 };
      }

      return { node: parent, offset: index + 1, remaining: remaining - tokenLength };
    }

    for (const child of Array.from(node.childNodes)) {
      const point = resolveSelectionPoint(child, remaining);

      if (!point) {
        continue;
      }

      if (point.remaining === 0) {
        return point;
      }

      remaining = point.remaining;
    }

    return { node, offset: node.childNodes.length, remaining };
  }

  return { node, offset: 0, remaining };
}

function insertTextIntoTodoReferenceEditor(text: string) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  const textNode = document.createTextNode(text);

  range.deleteContents();
  range.insertNode(textNode);
  range.setStart(textNode, text.length);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
