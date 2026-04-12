import { useEffect, useRef, type RefObject } from "react";

interface UseDismissOnOutsideOptions<T extends HTMLElement> {
  enabled: boolean;
  onDismiss: () => void;
  ignoredRefs?: Array<RefObject<HTMLElement | null>>;
  listenFocusIn?: boolean;
}

function isEventInside(
  target: EventTarget | null,
  refs: Array<RefObject<HTMLElement | null>>,
) {
  if (!(target instanceof Node)) {
    return false;
  }

  return refs.some((ref) => ref.current?.contains(target));
}

export function useDismissOnOutside<T extends HTMLElement>({
  enabled,
  onDismiss,
  ignoredRefs = [],
  listenFocusIn = true,
}: UseDismissOnOutsideOptions<T>) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const refs = [ref as RefObject<HTMLElement | null>, ...ignoredRefs];

    const handlePointerDown = (event: PointerEvent) => {
      if (isEventInside(event.target, refs)) {
        return;
      }

      onDismiss();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (isEventInside(event.target, refs)) {
        return;
      }

      onDismiss();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    if (listenFocusIn) {
      document.addEventListener("focusin", handleFocusIn);
    }

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      if (listenFocusIn) {
        document.removeEventListener("focusin", handleFocusIn);
      }
    };
  }, [enabled, ignoredRefs, listenFocusIn, onDismiss]);

  return ref;
}
