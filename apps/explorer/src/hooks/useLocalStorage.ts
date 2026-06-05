import { useCallback, useEffect, useRef, useState } from "react";

export interface LocalStorageCodec<T> {
  decode: (value: unknown) => T;
  encode: (value: T) => unknown;
}

export const finiteNumberLocalStorageCodec: LocalStorageCodec<number> = {
  decode: (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError("Expected a finite number");
    }
    return value;
  },
  encode: (value) => {
    if (!Number.isFinite(value)) {
      throw new TypeError("Expected a finite number");
    }
    return value;
  }
};

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Array.from(store.keys()).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value)
        };
      })();

const decode = <T>(codec: LocalStorageCodec<T>, value: string) => {
  return codec.decode(JSON.parse(value));
};

const encode = <T>(codec: LocalStorageCodec<T>, value: T) => {
  return JSON.stringify(codec.encode(value));
};

export const getLocalStorageItem = <T>(
  key: string,
  codec: LocalStorageCodec<T>
): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(codec, item) : null;
};

export const setLocalStorageItem = <T>(
  key: string,
  value: T,
  codec: LocalStorageCodec<T>
) => {
  const valueToSet = encode(codec, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "koed-explorer:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key }
    })
  );
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  codec: LocalStorageCodec<T>
): [T, (value: T | ((val: T) => T)) => void] {
  // Get the initial value from localStorage or use the provided initialValue
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = getLocalStorageItem(key, codec);
      return item ?? initialValue;
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
      return initialValue;
    }
  });

  // Return a wrapped version of useState's setter function that persists the new value to localStorage
  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        setStoredValue((prev) => {
          const valueToStore =
            typeof value === "function"
              ? (value as (val: T) => T)(prev)
              : value;
          if (valueToStore === null) {
            removeLocalStorageItem(key);
          } else {
            setLocalStorageItem(key, valueToStore, codec);
          }
          // Dispatch event after state update completes to avoid nested state updates
          queueMicrotask(() => dispatchLocalStorageChange(key));
          return valueToStore;
        });
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    },
    [key, codec]
  );

  const prevKeyRef = useRef(key);

  // Re-sync from localStorage when key changes
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      try {
        const newValue = getLocalStorageItem(key, codec);
        setStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    }
  }, [key, initialValue, codec]);

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const newValue = getLocalStorageItem(key, codec);
        setStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (
      event: CustomEvent<LocalStorageChangeDetail>
    ) => {
      if (event.detail.key === key) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(
      LOCAL_STORAGE_CHANGE_EVENT,
      handleLocalChange as EventListener
    );

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(
        LOCAL_STORAGE_CHANGE_EVENT,
        handleLocalChange as EventListener
      );
    };
  }, [key, initialValue, codec]);

  return [storedValue, setValue];
}
