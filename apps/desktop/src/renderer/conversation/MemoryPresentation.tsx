import {
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode
} from "react";

export type MemoryPresentationScope = "personal" | "team" | "workspace";

export type MemoryEventFrameProps<TElement extends ElementType = "article"> = {
  actions?: ReactNode;
  as?: TElement;
  children: ReactNode;
  contentType: string;
  header: ReactNode;
  metadata?: ReactNode;
  scope?: MemoryPresentationScope;
} & Omit<
  ComponentPropsWithoutRef<TElement>,
  "actions" | "as" | "children" | "contentType" | "header" | "metadata"
>;

export function MemoryEventFrame<TElement extends ElementType = "article">({
  actions,
  as,
  children,
  contentType,
  header,
  metadata,
  scope,
  ...elementProps
}: MemoryEventFrameProps<TElement>) {
  const Element = as ?? "article";
  return (
    <Element
      {...elementProps}
      data-memory-content-type={contentType}
      data-memory-scope={scope}
    >
      <header>
        <div>{header}</div>
        {actions ? <div>{actions}</div> : null}
      </header>
      <div>{children}</div>
      {metadata ? <footer>{metadata}</footer> : null}
    </Element>
  );
}

export type EvidenceBundleItem = {
  excerpt: ReactNode;
  id: string;
  metadata?: ReactNode;
  source: ReactNode;
};

export type EvidenceBundleProps = Omit<
  ComponentPropsWithoutRef<"section">,
  "children" | "title"
> & {
  emptyState?: ReactNode;
  evidence: readonly EvidenceBundleItem[];
  title?: ReactNode;
};

export function EvidenceBundle({
  emptyState = "No evidence is available.",
  evidence,
  title = "Evidence Bundle",
  ...sectionProps
}: EvidenceBundleProps) {
  return (
    <section {...sectionProps}>
      <header>{title}</header>
      {evidence.length === 0 ? (
        <div>{emptyState}</div>
      ) : (
        <ol>
          {evidence.map((item) => (
            <li key={item.id}>
              <div>{item.source}</div>
              <div>{item.excerpt}</div>
              {item.metadata ? <div>{item.metadata}</div> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export type MemorySourcePart = {
  actorName: string | null;
  body: ReactNode;
  id: string;
  sourceKind: string;
  toolCallId?: string | null;
  toolName?: string | null;
};

export function MemorySourceParts({
  parts,
  renderIcon
}: {
  parts: readonly MemorySourcePart[];
  renderIcon?: (part: MemorySourcePart) => ReactNode;
}) {
  return (
    <div className="memory-source-parts">
      {parts.map((part) => (
        <section
          className="memory-source-part"
          data-source-kind={part.sourceKind}
          key={part.id}
        >
          {renderIcon ? (
            <span aria-hidden="true">{renderIcon(part)}</span>
          ) : null}
          <div>
            <strong>
              {part.actorName ?? part.sourceKind.replaceAll("_", " ")}
            </strong>
            {part.toolName ? <span>{part.toolName}</span> : null}
            {part.toolCallId ? (
              <span title={part.toolCallId}>
                Call {part.toolCallId.slice(0, 8)}
              </span>
            ) : null}
            <div>{part.body}</div>
          </div>
        </section>
      ))}
    </div>
  );
}

export function LcmSummaryFrame({
  occurredAt,
  representation,
  sourceCount,
  summary,
  timeLabel
}: {
  occurredAt: string;
  representation: "lcm_leaves" | "lcm_rollups";
  sourceCount: number;
  summary: ReactNode;
  timeLabel: ReactNode;
}) {
  return (
    <article
      className="memory-lcm-summary"
      data-representation={representation}
      role="listitem"
    >
      <header>
        <strong>
          {representation === "lcm_leaves"
            ? "LCM leaf summary"
            : "LCM rollup summary"}
        </strong>
        <time dateTime={occurredAt}>{timeLabel}</time>
      </header>
      <div>{summary}</div>
      <footer>{sourceCount} source items</footer>
    </article>
  );
}
