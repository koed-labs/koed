import type { ReactNode } from "react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue
} from "@koed/ui";
import { X } from "lucide-react";
import "./project-management.css";

export function ProjectChoice({
  label,
  value,
  options,
  onChange,
  disabled
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup
        className="v1-app v1-project-ui v1-pm-select"
        alignItemWithTrigger={false}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function ProjectPopup({
  title,
  description,
  settings = false,
  busy = false,
  children,
  onClose
}: {
  title: string;
  description?: string;
  settings?: boolean;
  busy?: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        className={`v1-app v1-project-ui v1-pm-dialog ${settings ? "v1-pm-settings" : "v1-pm-action"}`}
        showCloseButton={false}
      >
        {settings ? (
          <DialogTitle className="sr-only">{title}</DialogTitle>
        ) : (
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription>{description}</DialogDescription>
            )}
          </DialogHeader>
        )}
        {children}
        <DialogClose
          aria-label={`Close ${title}`}
          disabled={busy}
          className="v1-pm-dialog-close"
          render={<Button variant="ghost" size="icon-sm" />}
        >
          <X />
        </DialogClose>
      </DialogPopup>
    </Dialog>
  );
}

export function ProjectError({ error }: { error?: string | null }) {
  return error ? (
    <p className="v1-pm-error" role="alert">
      {error}
    </p>
  ) : null;
}
