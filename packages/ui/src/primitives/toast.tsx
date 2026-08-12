"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { XIcon } from "lucide-react";

import { cn } from "../cn.js";
import { Button } from "./button.js";

type ToastTone = "neutral" | "success" | "warning" | "destructive";
type ToastAction = {
  label: string;
  onClick: () => void;
};
type ToastInput = {
  action?: ToastAction;
  description?: string;
  duration?: number;
  icon?: ReactNode;
  onDismiss?: () => void;
  title: string;
  tone?: ToastTone;
};
type ToastRecord = ToastInput & { id: number };
type ToastContextValue = {
  dismiss: (id: number, invokeOnDismiss?: boolean) => void;
  toast: (input: ToastInput) => number;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const records = useRef<ToastRecord[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number, invokeOnDismiss = true) => {
    const item = records.current.find((candidate) => candidate.id === id);
    if (!item) return;
    const timer = timers.current.get(id);
    if (timer) globalThis.clearTimeout(timer);
    timers.current.delete(id);
    records.current = records.current.filter(
      (candidate) => candidate.id !== id
    );
    setToasts(records.current);
    if (invokeOnDismiss) item.onDismiss?.();
  }, []);
  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      const evicted = records.current.slice(
        0,
        Math.max(0, records.current.length - 3)
      );
      for (const item of evicted) {
        const timer = timers.current.get(item.id);
        if (timer) globalThis.clearTimeout(timer);
        timers.current.delete(item.id);
        item.onDismiss?.();
      }
      records.current = [...records.current.slice(-3), { ...input, id }];
      setToasts(records.current);
      timers.current.set(
        id,
        globalThis.setTimeout(() => dismiss(id), input.duration ?? 5000)
      );
      return id;
    },
    [dismiss]
  );
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) {
        globalThis.clearTimeout(timer);
      }
      timers.current.clear();
    },
    []
  );
  const value = useMemo(() => ({ dismiss, toast }), [dismiss, toast]);
  return (
    <ToastContext value={value}>
      {children}
      <div
        aria-atomic="false"
        aria-live="polite"
        className="pointer-events-none fixed left-1/2 top-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
      >
        {toasts.map((item) => (
          <div
            className={cn(
              "pointer-events-auto relative flex items-start gap-3 rounded-lg border bg-popover p-3 pr-10 text-sm text-popover-foreground shadow-lg",
              item.tone === "success" && "border-success/40",
              item.tone === "warning" && "border-warning/40",
              item.tone === "destructive" && "border-destructive/40"
            )}
            data-toast=""
            data-tone={item.tone ?? "neutral"}
            key={item.id}
            role={item.tone === "destructive" ? "alert" : "status"}
          >
            {item.icon ? (
              <span
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 shrink-0 text-muted-foreground [&>svg]:size-4",
                  item.tone === "success" && "text-success",
                  item.tone === "warning" && "text-warning",
                  item.tone === "destructive" && "text-destructive"
                )}
              >
                {item.icon}
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{item.title}</div>
              {item.description ? (
                <div className="mt-1 text-muted-foreground">
                  {item.description}
                </div>
              ) : null}
              {item.action ? (
                <Button
                  className="mt-2"
                  onClick={() => {
                    item.action?.onClick();
                    dismiss(item.id);
                  }}
                  size="sm"
                  variant="outline"
                >
                  {item.action.label}
                </Button>
              ) : null}
            </div>
            <Button
              aria-label="Dismiss notification"
              className="absolute right-1.5 top-1.5"
              onClick={() => dismiss(item.id)}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used within ToastProvider.");
  return value;
}

export {
  ToastProvider,
  useToast,
  type ToastAction,
  type ToastInput,
  type ToastTone
};
