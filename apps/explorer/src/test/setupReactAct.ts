(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hasUsableLocalStorage = (value: unknown): value is Storage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Storage).getItem === "function" &&
  typeof (value as Storage).setItem === "function" &&
  typeof (value as Storage).removeItem === "function" &&
  typeof (value as Storage).clear === "function";

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    }
  };
};

if (!hasUsableLocalStorage(globalThis.localStorage)) {
  const storage = createMemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage
    });
  }
}
