import { useCallback, useRef, useState } from "react";

type ExclusiveActivationKey = number | string;
type CommitOrCloseHandler = () => Promise<boolean> | boolean;

export function useExclusiveActivation<TKey extends ExclusiveActivationKey>() {
  const [activeKeyState, setActiveKeyState] = useState<TKey | null>(null);
  const activeKeyRef = useRef<TKey | null>(null);
  const handlersRef = useRef(new Map<TKey, () => Promise<boolean>>());
  const requestChainRef = useRef(Promise.resolve(true));

  const setActiveKey = useCallback((nextKey: TKey | null) => {
    activeKeyRef.current = nextKey;
    setActiveKeyState(nextKey);
  }, []);

  const register = useCallback((key: TKey, handler: CommitOrCloseHandler) => {
    const wrappedHandler = async () => Promise.resolve(handler());
    handlersRef.current.set(key, wrappedHandler);

    return () => {
      if (handlersRef.current.get(key) === wrappedHandler) {
        handlersRef.current.delete(key);
      }
    };
  }, []);

  const clearActive = useCallback(
    (key?: TKey) => {
      if (typeof key !== "undefined" && activeKeyRef.current !== key) {
        return;
      }
      setActiveKey(null);
    },
    [setActiveKey],
  );

  const requestActivation = useCallback(
    (nextKey: TKey | null) => {
      const runRequest = requestChainRef.current.then(async () => {
        const currentKey = activeKeyRef.current;
        if (currentKey === nextKey) {
          return true;
        }

        if (currentKey !== null) {
          const commitOrClose = handlersRef.current.get(currentKey);
          const canLeaveCurrent = commitOrClose ? await commitOrClose() : true;

          if (!canLeaveCurrent) {
            return false;
          }

          if (activeKeyRef.current === currentKey) {
            setActiveKey(null);
          }
        }

        setActiveKey(nextKey);
        return true;
      });

      requestChainRef.current = runRequest.catch(() => true);
      return runRequest;
    },
    [setActiveKey],
  );

  return {
    activeKey: activeKeyState,
    clearActive,
    register,
    requestActivation,
  };
}
