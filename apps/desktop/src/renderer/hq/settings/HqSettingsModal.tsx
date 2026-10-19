import { useRef, type ReactNode } from "react";
import { Dialog, DialogPopup } from "@koed/ui";

/** Keep focus, inert background, and nested dismissal in the shared headless primitive. */
export function HqSettingsModal({
  children,
  className,
  labelledBy,
  describedBy,
  onClose
}: {
  children: ReactNode;
  className: string;
  labelledBy: string;
  describedBy?: string;
  onClose: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        ref={popup}
        initialFocus={popup}
        className={className}
        data-hq-shell=""
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        showCloseButton={false}
      >
        {children}
      </DialogPopup>
    </Dialog>
  );
}
