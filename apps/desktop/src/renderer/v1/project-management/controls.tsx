import { Pixelkin } from "../pixelkin/Pixelkin.js";
import type { AgentLook } from "../pixelkin/agent-kin.js";
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
} from "@koed-labs/ui";
import { X } from "lucide-react";
import "./project-management.css";

export function ProjectChoice({
  label,
  value,
  options,
  onChange,
  placeholder,
  portalContainer,
  disabled
}: {
  label: string;
  value: string | null;
  placeholder?: string;
  portalContainer?: HTMLElement | null;
  // A Kin look shows that Project's Kin beside its name in the list.
  options: { value: string; label: string; look?: AgentLook }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // With Kins, the list marks the chosen Project like a selected Conversation
  // instead of with a tick, and the closed picker shows its Kin too.
  const withKins = options.some((option) => option.look);
  const optionContent = (option: (typeof options)[number]) =>
    option.look ? (
      <span className="v1-pm-select-option">
        <Pixelkin
          look={option.look}
          size={20}
          className="v1-pm-row-kin"
          motion="still"
        />
        {option.label}
      </span>
    ) : (
      option.label
    );
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
        {withKins ? (
          <SelectValue placeholder={placeholder}>
            {(current: string | null) => {
              const option = options.find((item) => item.value === current);
              return option ? optionContent(option) : (placeholder ?? null);
            }}
          </SelectValue>
        ) : (
          <SelectValue placeholder={placeholder} />
        )}
      </SelectTrigger>
      <SelectPopup
        className="v1-app v1-project-ui v1-pm-select"
        portalContainer={portalContainer}
        alignItemWithTrigger={false}
      >
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            hideIndicator={withKins}
          >
            {optionContent(option)}
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
