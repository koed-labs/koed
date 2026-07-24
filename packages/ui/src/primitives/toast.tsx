"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { XIcon } from "lucide-react";

import { cn } from "../cn.js";
import { Button } from "./button.js";

type ToastTone = "neutral" | "success" | "warning" | "destructive";
type ToastInput = {
  description?: string;
  duration?: number;
  title: string;
  tone?: ToastTone;
};
type ToastRecord = ToastInput & { id: number };
type ToastContextValue = {
  dismiss: (id: number) => void;
  toast: (input: ToastInput) => number;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);
  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { ...input, id }]);
      globalThis.setTimeout(() => dismiss(id), input.duration ?? 5000);
      return id;
    },
    [dismiss]
  );
  const value = useMemo(() => ({ dismiss, toast }), [dismiss, toast]);
  return (
    <ToastContext value={value}>
      {children}
      <div
        aria-atomic="false"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((item) => (
          <div
            className={cn(
              "pointer-events-auto relative rounded-lg border bg-popover p-3 pr-10 text-sm text-popover-foreground shadow-md/10",
              item.tone === "success" && "border-success/40",
              item.tone === "warning" && "border-warning/40",
              item.tone === "destructive" && "border-destructive/40"
            )}
            key={item.id}
            role={item.tone === "destructive" ? "alert" : "status"}
          >
            <div className="font-medium">{item.title}</div>
            {item.description ? (
              <div className="mt-1 text-muted-foreground">
                {item.description}
              </div>
            ) : null}
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

export { ToastProvider, useToast, type ToastInput, type ToastTone };
