/**
 * Shared collaboration renderer primitives.
 *
 * These were module-local to CollaborationRoutesImpl until the People
 * workflow moved into its own module. They live here so both modules can
 * import them without a cycle; behaviour is unchanged.
 */
import { Dialog, DialogPopup } from "@koed/ui";
import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";

import { CollaborationClientError } from "../../collaboration/renderer-client.js";

export const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
};

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
};

export const normalizedText = (value: string): string =>
  value.normalize("NFC").trim();
export const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;
export const codePointLength = (value: string): number =>
  [...value.normalize("NFC")].length;

export class CollaborationInputError extends Error {}

export const failureMessage = (cause: unknown, fallback: string): string =>
  cause instanceof CollaborationClientError
    ? cause.userMessage
    : cause instanceof CollaborationInputError
      ? cause.message
      : fallback;

export function Modal({
  children,
  className,
  label,
  onClose
}: {
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogPopup
        aria-label={label}
        aria-modal="true"
        className={`collab-modal${className ? ` ${className}` : ""}`}
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>(
            "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), .collab-command-list button:not([disabled]), .collab-modal-actions button:not([disabled])"
          ) ?? true
        }
        ref={popupRef}
        showCloseButton={false}
      >
        {children}
      </DialogPopup>
    </Dialog>
  );
}

export function ModalHeader({
  title,
  onClose
}: {
  title: string;
  onClose: () => void;
}) {
  return (
    <header className="collab-modal-header">
      <div className="collab-modal-title">
        <h2>{title}</h2>
      </div>
      <button
        type="button"
        className="collab-icon-button"
        aria-label={`Close ${title}`}
        title="Close"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </button>
    </header>
  );
}
