import { useEffect, useRef, useState, type TransitionEvent } from "react";

import { MOTION_DURATION_MS } from "../ui/motion";

export type MotionPresenceState = "entering" | "open" | "closing";

export function useMotionPresence(
  visible: boolean,
  options: {
    commitExit?: (update: () => void) => void;
  } = {},
) {
  const commitExitRef = useRef(options.commitExit);
  const finishExitRef = useRef<() => void>(() => undefined);
  const [mounted, setMounted] = useState(visible);
  const [state, setState] = useState<MotionPresenceState>(visible ? "open" : "closing");
  commitExitRef.current = options.commitExit;

  useEffect(() => {
    let frame = 0;
    let timer = 0;
    let exitFinished = false;

    const finishExit = () => {
      if (exitFinished || visible) return;
      exitFinished = true;
      window.clearTimeout(timer);
      const unmount = () => setMounted(false);
      if (commitExitRef.current) commitExitRef.current(unmount);
      else unmount();
    };
    finishExitRef.current = finishExit;

    if (visible) {
      setMounted(true);
      setState("entering");
      frame = window.requestAnimationFrame(() => setState("open"));
    } else if (mounted) {
      setState("closing");
      timer = window.setTimeout(finishExit, MOTION_DURATION_MS.standard);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [mounted, visible]);

  function onTransitionEnd(event: TransitionEvent<HTMLElement>) {
    if (state === "closing" && event.target === event.currentTarget) {
      finishExitRef.current();
    }
  }

  return { mounted, state, onTransitionEnd };
}
