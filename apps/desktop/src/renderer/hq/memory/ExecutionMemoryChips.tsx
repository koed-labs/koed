import { Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ManagedConversationDesktopApi,
  ManagedConversationTurnCitation
} from "../../../ipc/managed-conversation-protocol.js";
import { CitationDetail } from "../conversation/Citations.js";
import { visibleTurnCitations } from "./execution-memory-chips.js";
import "./execution-memory-chips.css";

export function ExecutionMemoryChips({
  api,
  ownerId,
  profileKey,
  projectId,
  executionId,
  executionGeneration,
  providerTurnId,
  variant,
  panelHost,
  panelActive = true,
  onPanelOpen,
  onPanelClose,
  onOpenMessage
}: {
  api?: ManagedConversationDesktopApi | null;
  ownerId?: string | null;
  profileKey?: string | null;
  projectId: string;
  executionId: string;
  executionGeneration?: number;
  providerTurnId: string | null;
  variant: "why" | "count";
  panelHost?: HTMLElement | null;
  panelActive?: boolean;
  onPanelOpen?: () => void;
  onPanelClose?: () => void;
  onOpenMessage?: (
    target: NonNullable<ManagedConversationTurnCitation["messageTarget"]>
  ) => Promise<boolean>;
}) {
  const [state, setState] = useState<{
    key: string;
    citations: ManagedConversationTurnCitation[];
  } | null>(null);
  const [selected, setSelected] = useState<{
    key: string;
    citation: ManagedConversationTurnCitation;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const citationRequest = useRef(0);
  const detailRequest = useRef(0);
  const identity = useRef({
    api,
    ownerId,
    profileKey,
    projectId,
    executionId,
    executionGeneration,
    providerTurnId,
    generation: 0
  });
  if (
    identity.current.api !== api ||
    identity.current.ownerId !== ownerId ||
    identity.current.profileKey !== profileKey ||
    identity.current.projectId !== projectId ||
    identity.current.executionId !== executionId ||
    identity.current.executionGeneration !== executionGeneration ||
    identity.current.providerTurnId !== providerTurnId
  ) {
    identity.current = {
      api,
      ownerId,
      profileKey,
      projectId,
      executionId,
      executionGeneration,
      providerTurnId,
      generation: identity.current.generation + 1
    };
    citationRequest.current++;
    detailRequest.current++;
  }
  const key = [
    ownerId,
    profileKey,
    projectId,
    executionId,
    executionGeneration,
    providerTurnId,
    identity.current.generation
  ].join("\u0000");
  const citations = state?.key === key ? state.citations : [];
  const selectedForTurn = selected?.key === key ? selected.citation : null;
  const isOpen = open === key;

  useEffect(() => {
    let live = true;
    let sequence = ++citationRequest.current;
    setState(null);
    setSelected(null);
    setOpen(null);
    setDetailLoading(false);
    if (!api?.turnCitations || !providerTurnId || !ownerId || !profileKey)
      return;
    const read = (force = false) => {
      if (!force && document.visibilityState === "hidden") return;
      const current = ++sequence;
      void api.turnCitations!(executionId, providerTurnId).then(
        (result) => {
          if (live && sequence === current) {
            const next = visibleTurnCitations(result.citations, providerTurnId);
            setState({ key, citations: next });
            setSelected((previous) => {
              if (!previous || previous.key !== key) return previous;
              const currentCitation = next.find(
                (citation) => citation.alias === previous.citation.alias
              );
              if (!currentCitation) {
                detailRequest.current++;
                return null;
              }
              if (!currentCitation.detailAvailable) {
                detailRequest.current++;
                return { key, citation: currentCitation };
              }
              return previous;
            });
          }
        },
        () => {
          if (live && sequence === current) setState({ key, citations: [] });
        }
      );
    };
    read(true);
    const timer = window.setInterval(() => read(), 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") read(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      citationRequest.current++;
    };
  }, [
    api,
    ownerId,
    profileKey,
    projectId,
    executionId,
    executionGeneration,
    providerTurnId,
    key
  ]);

  if (!citations.length || !providerTurnId) return null;
  const label =
    variant === "why"
      ? `Why: ${citations[0]!.title}`
      : `${citations.length} ${citations.length === 1 ? "memory" : "memories"}`;
  const showDetail = (citation: ManagedConversationTurnCitation) => {
    if (!api?.citationDetail) return;
    const sequence = ++detailRequest.current;
    setDetailLoading(true);
    setSelected({ key, citation: { ...citation, detailAvailable: false } });
    void api.citationDetail(executionId, providerTurnId, citation.alias).then(
      (result) => {
        if (detailRequest.current === sequence) {
          setSelected({
            key,
            citation: result.citation ?? { ...citation, detailAvailable: false }
          });
          setDetailLoading(false);
        }
      },
      () => {
        if (detailRequest.current === sequence) {
          setSelected({
            key,
            citation: { ...citation, detailAvailable: false }
          });
          setDetailLoading(false);
        }
      }
    );
  };
  return (
    <div className="hq-execution-memory">
      <button
        type="button"
        className="hq-execution-memory__chip"
        aria-label={label}
        aria-expanded={variant === "count" ? isOpen : undefined}
        onClick={() => {
          if (variant === "count" && isOpen) {
            setOpen(null);
            onPanelClose?.();
            return;
          }
          onPanelOpen?.();
          if (variant === "why") {
            setOpen(null);
            showDetail(citations[0]!);
          } else setOpen(isOpen ? null : key);
        }}
      >
        <Sparkles size={12} aria-hidden="true" /> {label}
      </button>
      {panelActive && panelHost && (isOpen || selectedForTurn)
        ? createPortal(
            <div className="hq-execution-memory__pane">
              {isOpen ? (
                <div
                  className="hq-execution-memory__panel"
                  role="group"
                  aria-label="Memory sources"
                >
                  <header>
                    <strong>From memory</strong>
                    <button
                      type="button"
                      className="hq-execution-memory__close"
                      aria-label="Close memory sources"
                      onClick={() => {
                        setOpen(null);
                        onPanelClose?.();
                      }}
                    >
                      <X size={16} />
                    </button>
                  </header>
                  {citations.map((citation) => (
                    <button
                      type="button"
                      key={citation.alias}
                      onClick={() => {
                        showDetail(citation);
                        setOpen(null);
                      }}
                    >
                      {citation.title}
                    </button>
                  ))}
                </div>
              ) : (
                <CitationDetail
                  citation={selectedForTurn}
                  loading={detailLoading}
                  onOpenMessage={onOpenMessage}
                  onClose={() => {
                    detailRequest.current++;
                    setSelected(null);
                    onPanelClose?.();
                  }}
                />
              )}
            </div>,
            panelHost
          )
        : null}
    </div>
  );
}
