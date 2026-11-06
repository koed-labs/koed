import { useId, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  ChevronRight,
  Cpu,
  Info,
  Layers3,
  Settings2,
  ShieldCheck,
  Terminal
} from "lucide-react";
import {
  Button,
  Card,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@koed/ui";

export const sections = {
  general: {
    label: "General",
    icon: Settings2,
    description: "Appearance, device preferences, and optional tools."
  },
  ai: {
    label: "AI models",
    icon: Cpu,
    description: "Connect your AI Clients and choose a Memory Model."
  },
  services: {
    label: "Services",
    icon: Activity,
    description: "Service health and indexing activity on this device."
  },
  about: {
    label: "About",
    icon: Info,
    description: "Koed Desktop version, updates, and data."
  }
};
export type Section = keyof typeof sections;
export const details = {
  privacy: {
    label: "Privacy Filter",
    icon: ShieldCheck,
    parent: "general",
    description:
      "Filter personal information before sharing Memory with your Team."
  },
  cli: {
    label: "Command line",
    icon: Terminal,
    parent: "general",
    description: "Use the koed command from your terminal."
  },
  health: {
    label: "Service health",
    icon: Activity,
    parent: "services",
    description: "Inspect the services reported by this installation."
  },
  embedding: {
    label: "Embedding status",
    icon: Layers3,
    parent: "services",
    description: "Progress, queues, and activity for your local memory index."
  }
} as const;
export type Detail = keyof typeof details;
export const pages = { ...sections, ...details };
export type Page = keyof typeof pages;
export function Group({
  title,
  children
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="group-block">
      <h3 id={id}>{title}</h3>
      <Card className="group-card">{children}</Card>
    </section>
  );
}
export function Row({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="row-copy">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}
export function PageLink({
  page,
  onOpen,
  note
}: {
  page: Detail;
  onOpen: (p: Detail) => void;
  note?: string;
}) {
  const { icon: Icon, label, description } = pages[page];
  return (
    <Button
      variant="ghost"
      className="page-link"
      data-settings-page={page}
      onClick={() => onOpen(page)}
    >
      <span className="link-icon">
        <Icon />
      </span>
      <span className="row-copy">
        <strong>{label}</strong>
        <small>{note ?? description}</small>
      </span>
      <ChevronRight className="trailing-icon" />
    </Button>
  );
}
export function Back({
  label,
  onClick
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="back"
      aria-label={`Back to ${label}`}
      onClick={onClick}
    >
      <ArrowLeft />
      {label}
    </Button>
  );
}
export function PageHeading({
  page,
  onBack
}: {
  page: Page;
  onBack?: () => void;
}) {
  const detail = Object.hasOwn(details, page) ? details[page as Detail] : null;
  return (
    <header className="page-heading">
      {detail && onBack && (
        <Back label={sections[detail.parent].label} onClick={onBack} />
      )}
      <h2 tabIndex={-1}>{pages[page].label}</h2>
      <p>{pages[page].description}</p>
    </header>
  );
}
export function ConfirmAction({
  title,
  description,
  label,
  destructive,
  close,
  confirm
}: {
  title: string;
  description: string;
  label: string;
  destructive?: boolean;
  close: () => void;
  confirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup
        showCloseButton={false}
        className="v1-settings-confirm v1-app v1-project-ui"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              close();
              confirm();
            }}
          >
            {label}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
