import type { ReactNode, RefObject } from "react";

export const formatDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(date);
};

export function ApprovalShell({
  eyebrow,
  title,
  description,
  tone,
  children
}: {
  eyebrow: string;
  title: string;
  description?: string | null;
  tone: "waiting" | "success" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <main>
      <section className="card">
        <header>
          <div aria-hidden="true" className={`mark ${tone}`}>
            K
          </div>
          <div className="heading">
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
            {description ? <p className="description">{description}</p> : null}
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}

export function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function Status({
  message,
  error,
  terminal,
  statusRef
}: {
  message: string;
  error?: string | null;
  terminal?: boolean;
  statusRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      aria-live="polite"
      className="status"
      ref={statusRef}
      role="status"
      tabIndex={terminal ? -1 : undefined}
    >
      <p>{message}</p>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
