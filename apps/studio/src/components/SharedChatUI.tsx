"use client";

import { MessageSquare } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import { AgentAvatarView } from "./AgentAvatarView";
import {
  activeChatExchange,
  chatNavigationMessages,
  chatNavigationPreview,
  isChatNavigationCompact,
  type SharedChatMessage,
  type SharedChatMode
} from "@/lib/shared-chat-model";
export type {
  SharedChatMessage,
  SharedChatMode
} from "@/lib/shared-chat-model";

type SharedChatUIProps<T extends SharedChatMessage> = {
  mode: SharedChatMode;
  scopeKey: string;
  messages: readonly T[];
  composer: ReactNode;
  children?: ReactNode;
  childrenAfter?: ReactNode;
  emptyState?: ReactNode;
  className?: string;
  viewportClassName?: string;
  listClassName?: string;
  renderMessage?: (message: T) => ReactNode;
  composerOnly?: boolean;
};

/**
 * Common conversation chrome. Controllers keep their transport and authority;
 * callers adapt their records and supply only message-specific details.
 */
export function SharedChatUI<T extends SharedChatMessage>(
  props: SharedChatUIProps<T>
) {
  return <SharedChatUIContents key={props.scopeKey} {...props} />;
}

function SharedChatUIContents<T extends SharedChatMessage>({
  mode,
  scopeKey,
  messages,
  composer,
  children,
  childrenAfter,
  emptyState,
  className = "",
  viewportClassName = "",
  listClassName = "",
  renderMessage,
  composerOnly = false
}: SharedChatUIProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const wasAtBottom = useRef(true);
  const [navigation, setNavigation] = useState<{
    scopeKey: string;
    activeId: string | null;
    previewId: string | null;
  }>({ scopeKey, activeId: null, previewId: null });
  const activeId =
    navigation.scopeKey === scopeKey ? navigation.activeId : null;
  const previewId =
    navigation.scopeKey === scopeKey ? navigation.previewId : null;
  const setActiveId = useCallback(
    (value: string | null) => {
      setNavigation((current) => ({
        scopeKey,
        activeId: value,
        previewId: current.scopeKey === scopeKey ? current.previewId : null
      }));
    },
    [scopeKey]
  );
  const setPreviewId = useCallback(
    (value: string | null | ((current: string | null) => string | null)) => {
      setNavigation((current) => ({
        scopeKey,
        activeId: current.scopeKey === scopeKey ? current.activeId : null,
        previewId:
          typeof value === "function"
            ? value(current.scopeKey === scopeKey ? current.previewId : null)
            : value
      }));
    },
    [scopeKey]
  );
  const [isCompact, setIsCompact] = useState(false);
  const viewerMessages = useMemo(
    () => chatNavigationMessages(messages),
    [messages]
  );

  const isAtBottom = useCallback(() => {
    const viewport = viewportRef.current;
    return (
      !viewport ||
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 56
    );
  }, []);

  useEffect(() => {
    wasAtBottom.current = true;
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [scopeKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && wasAtBottom.current)
      viewport.scrollTop = viewport.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateActiveExchange = () => {
      const viewportTop = viewport.getBoundingClientRect().top;
      const current = messages.find((message) => {
        const element = messageRefs.current.get(message.id);
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewportTop + 48;
      });
      if (!current) return;
      const latestViewerAnchor = chatNavigationMessages(messages)
        .filter((message) => {
          const element = messageRefs.current.get(message.id);
          return element
            ? element.getBoundingClientRect().top <= viewportTop + 72
            : false;
        })
        .at(-1);
      setActiveId(
        latestViewerAnchor?.id ?? activeChatExchange(messages, current.id)
      );
    };
    updateActiveExchange();
    viewport.addEventListener("scroll", updateActiveExchange, {
      passive: true
    });
    const resizeObserver = new ResizeObserver(() => {
      if (wasAtBottom.current) viewport.scrollTop = viewport.scrollHeight;
      updateActiveExchange();
    });
    resizeObserver.observe(viewport);
    const content = contentRef.current;
    if (content) resizeObserver.observe(content);
    return () => {
      viewport.removeEventListener("scroll", updateActiveExchange);
      resizeObserver.disconnect();
    };
  }, [messages, scopeKey, setActiveId]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setIsCompact(isChatNavigationCompact(entry.contentRect.width))
    );
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const jumpTo = (id: string) => {
    const element = messageRefs.current.get(id);
    if (!element) return;
    wasAtBottom.current = false;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top =
      viewport.scrollTop +
      element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top;
    viewport.scrollTo({
      top,
      behavior: reducedMotion ? "auto" : "smooth"
    });
    setActiveId(id);
  };

  return (
    <div
      ref={shellRef}
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${className}`}
      data-chat-mode={mode.kind}
    >
      {!composerOnly && (
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={viewportRef}
            className={`min-h-0 min-w-0 flex-1 overflow-y-auto ${isCompact ? "" : "pl-8"} ${viewportClassName}`}
            aria-label={
              mode.kind === "agent" ? "Agent conversation" : "Team conversation"
            }
            onScroll={() => {
              wasAtBottom.current = isAtBottom();
            }}
          >
            <div ref={contentRef} className="min-w-0 max-w-full">
              {children}
              {messages.length > 0 ? (
                <div className={listClassName} aria-live="polite">
                  {messages.map((message) => (
                    <div
                      key={message.id}
                      ref={(element) => {
                        if (element)
                          messageRefs.current.set(message.id, element);
                        else messageRefs.current.delete(message.id);
                      }}
                      data-chat-message-id={message.id}
                      data-chat-viewer-message={
                        (message.authoredByViewer ?? message.role === "user")
                          ? "true"
                          : undefined
                      }
                      className="min-w-0 max-w-full scroll-mt-4"
                    >
                      {renderMessage?.(message)}
                    </div>
                  ))}
                </div>
              ) : (
                emptyState
              )}
              {childrenAfter}
            </div>
          </div>
          {viewerMessages.length > 0 && !isCompact && (
            <nav
              aria-label="Your messages in this conversation"
              className="absolute left-1 top-1/2 z-10 flex -translate-y-1/2 max-h-[calc(100%-1.5rem)] w-7 flex-col items-center gap-1 overflow-y-auto"
            >
              {viewerMessages.map((message, index) => {
                const preview = chatNavigationPreview(message.content);
                const isActive = activeId === message.id;
                return (
                  <button
                    key={message.id}
                    type="button"
                    aria-label={`Jump to your message ${index + 1}: ${preview || "empty message"}`}
                    aria-current={isActive ? "location" : undefined}
                    onClick={() => jumpTo(message.id)}
                    onPointerEnter={(
                      event: PointerEvent<HTMLButtonElement>
                    ) => {
                      if (event.pointerType === "mouse")
                        setPreviewId(message.id);
                    }}
                    onPointerLeave={() =>
                      setPreviewId((value) =>
                        value === message.id ? null : value
                      )
                    }
                    onFocus={() => setPreviewId(message.id)}
                    onBlur={(event: FocusEvent<HTMLButtonElement>) => {
                      if (
                        !event.currentTarget.parentElement?.contains(
                          event.relatedTarget as Node | null
                        )
                      )
                        setPreviewId((value) =>
                          value === message.id ? null : value
                        );
                    }}
                    className={`group relative flex h-3 w-6 shrink-0 items-center justify-center rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${isActive ? "" : ""}`}
                  >
                    <span
                      className={`h-px w-1.5 transition-all ${isActive ? "w-2 bg-accent" : "bg-border-strong group-hover:bg-accent"}`}
                    />
                  </button>
                );
              })}
            </nav>
          )}
          {previewId &&
            !isCompact &&
            (() => {
              const preview = viewerMessages.find(
                (message) => message.id === previewId
              );
              const text = preview
                ? chatNavigationPreview(preview.content)
                : "";
              return text ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute left-9 top-1/2 z-20 w-56 -translate-y-1/2 rounded-md border border-border bg-surface px-2.5 py-2 text-left text-[11px] leading-relaxed text-foreground shadow-lg"
                >
                  {text}
                </div>
              ) : null;
            })()}
        </div>
      )}
      <div className="shrink-0">{composer}</div>
    </div>
  );
}

/** Shared Agent bubble used by native, hosted and PR conversations. */
export function AgentChatMessage({
  message,
  children,
  compact = false,
  maxWidthClass = "max-w-[85%]"
}: {
  message: SharedChatMessage;
  children?: ReactNode;
  compact?: boolean;
  maxWidthClass?: "max-w-[80%]" | "max-w-[85%]";
}) {
  const author = message.author ?? null;
  if (message.role === "user") {
    return (
      <div className="flex min-w-0 justify-end">
        <div
          className={`${maxWidthClass} whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-surface-hover px-4 py-3 text-foreground ${compact ? "text-xs leading-5" : "text-[15px] leading-relaxed"}`}
        >
          {message.content}
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 justify-start">
      <div
        className={`flex min-w-0 ${maxWidthClass} items-start gap-2 sm:gap-3`}
      >
        {author ? (
          <AgentAvatarView
            image={author.avatar?.image}
            spec={author.avatar?.spec}
            name={author.name}
            size="md"
          />
        ) : (
          <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-hover text-subtle">
            <MessageSquare className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0 pt-1">
          {author && (
            <p className="mb-1 text-xs font-medium text-foreground">
              {author.name}
            </p>
          )}
          <p
            className={`whitespace-pre-wrap break-words text-foreground-secondary ${compact ? "text-xs leading-5" : "text-[15px] leading-relaxed"}`}
          >
            {message.content}
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}
