import { SecureMarkdown, type MarkdownPlatformAdapters } from "@koed/memory-ui";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ManagedConversationTurnCitation } from "../../../ipc/managed-conversation-protocol.js";

const tagPattern = /\[m:([A-Za-z0-9_-]+)\]/g;

export function CitedAnswer({
  source,
  citations,
  adapters,
  onOpen
}: {
  source: string;
  citations: ManagedConversationTurnCitation[];
  adapters: MarkdownPlatformAdapters;
  onOpen: (citation: ManagedConversationTurnCitation) => void;
}) {
  const available = new Map(
    citations.map((citation) => [citation.alias, citation])
  );
  const used: ManagedConversationTurnCitation[] = [];
  for (const match of source.matchAll(tagPattern)) {
    const citation = available.get(match[1]!);
    if (citation && !used.includes(citation)) used.push(citation);
  }
  const references = new Map(
    used.map((citation, index) => [
      citation.alias,
      {
        number: index + 1,
        onOpen: () => onOpen(citation)
      }
    ])
  );
  return (
    <>
      <SecureMarkdown
        source={source}
        adapters={adapters}
        citationReferences={references}
      />
      {used.length ? (
        <div className="hq-citation-sources" aria-label="From memory">
          <span className="hq-citation-sources__label">From memory</span>
          {used.map((citation, index) => (
            <button
              type="button"
              className="hq-citation-source"
              key={citation.alias}
              onClick={() => onOpen(citation)}
            >
              <span className="hq-citation-chip hq-citation-chip--small">
                {index + 1}
              </span>
              <span>{citation.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function CitationDetail({
  citation,
  loading,
  onClose,
  onOpenMessage
}: {
  citation: ManagedConversationTurnCitation | null;
  loading: boolean;
  onClose: () => void;
  onOpenMessage?: (
    target: NonNullable<ManagedConversationTurnCitation["messageTarget"]>
  ) => Promise<boolean>;
}) {
  const [messageUnavailable, setMessageUnavailable] = useState(false);
  useEffect(() => setMessageUnavailable(false), [citation?.alias]);
  if (!citation && !loading) return null;
  const typeLabel =
    citation?.sourceType === "curated_memory"
      ? citation.kind
        ? citation.kind.charAt(0).toUpperCase() + citation.kind.slice(1)
        : "Memory"
      : citation?.sourceType === "memory_event"
        ? "Memory event"
        : citation?.sourceType === "memory_node"
          ? "Memory summary"
          : "Chat";
  return (
    <aside className="hq-citation-detail" aria-label="Memory source detail">
      <div className="hq-citation-detail__head">
        <span>◉&nbsp; {typeLabel}</span>
        <button
          type="button"
          aria-label="Close memory source"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {loading ? (
        <p>Opening source…</p>
      ) : citation?.detailAvailable ? (
        <>
          <h2>{citation.title}</h2>
          {citation.summary && citation.summary !== citation.title ? (
            <p>{citation.summary}</p>
          ) : null}
          {citation.provenance ? (
            <div className="hq-citation-detail__provenance">
              <span>WHERE IT CAME FROM</span>
              <p>{citation.provenance}</p>
            </div>
          ) : null}
          {citation.replaces ? (
            <div className="hq-citation-detail__replaces">
              <span>REPLACES</span>
              <p>{citation.replaces}</p>
            </div>
          ) : null}
          {citation.visibility === "personal" &&
          citation.sourceType === "message" &&
          citation.messageTarget &&
          onOpenMessage ? (
            <button
              type="button"
              className="hq-citation-detail__open-message"
              onClick={() => {
                setMessageUnavailable(false);
                void onOpenMessage(citation.messageTarget!).then(
                  (opened) => {
                    if (!opened) setMessageUnavailable(true);
                  },
                  () => setMessageUnavailable(true)
                );
              }}
            >
              Open message
            </button>
          ) : null}
          {messageUnavailable ? (
            <p role="status">Source message unavailable.</p>
          ) : null}
        </>
      ) : (
        <p>This memory source is unavailable.</p>
      )}
    </aside>
  );
}
