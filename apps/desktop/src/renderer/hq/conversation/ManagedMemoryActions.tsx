import { useEffect, useRef, useState } from "react";
import type {
  ManagedMemoryAction,
  ManagedMemoryActionDesktopApi
} from "../../../ipc/managed-memory-action-protocol.js";
import "./hq-memory-actions.css";

/** Show only owner-facing results loaded from the current trusted Desktop profile. */
export function ManagedMemoryActions({
  refreshSignal,
  api,
  executionId,
  ownerId,
  profileKey,
  onChanged,
  onOfferChatForget
}: {
  /** Changes when the conversation's latest command changes state. */
  refreshSignal?: string;
  api: ManagedMemoryActionDesktopApi;
  executionId: string;
  ownerId?: string;
  profileKey?: string;
  onChanged?: () => void;
  onOfferChatForget?: (sourceSessionId: string) => Promise<boolean> | boolean;
}) {
  const [actions, setActions] = useState<ManagedMemoryAction[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);

  const loadRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    setActions([]);
    setBusyId(null);
    setError(null);
    busy.current = false;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const latest = await api.list(executionId);
        if (generation.current === current) {
          setActions(latest);
          setError(null);
        }
      } catch {
        if (generation.current === current)
          setError("Memory actions are temporarily unavailable.");
      }
    };
    void load();
    loadRef.current = load;
    // New actions follow a finished turn (see refreshSignal), so a slow
    // background check is enough between turns.
    const timer = setInterval(() => void load(), 20_000);
    const onVisibilityChange = () => void load();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      generation.current += 1;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [api, executionId, ownerId, profileKey]);
  useEffect(() => {
    if (refreshSignal) void loadRef.current?.();
  }, [refreshSignal]);

  const undo = async (action: ManagedMemoryAction) => {
    if (busy.current) return;
    busy.current = true;
    const current = generation.current;
    setBusyId(action.id);
    setError(null);
    try {
      const updated = await api.undo(executionId, action.id);
      if (generation.current !== current) return;
      setActions((previous) =>
        previous.map((item) => (item.id === action.id ? updated : item))
      );
      const latest = await api.list(executionId);
      if (generation.current !== current) return;
      setActions(latest);
      onChanged?.();
    } catch {
      if (generation.current === current)
        setError(
          "Undo is unavailable. The memory may have changed or the Undo window expired."
        );
    } finally {
      if (generation.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };

  const offerChatForget = async (action: ManagedMemoryAction) => {
    if (busy.current || !action.sourceSessionId || !onOfferChatForget) return;
    busy.current = true;
    const current = generation.current;
    setBusyId(action.id);
    setError(null);
    try {
      const opened = await onOfferChatForget(action.sourceSessionId);
      if (generation.current === current && !opened)
        setError("The source chat is unavailable. No chat was forgotten.");
    } catch {
      if (generation.current === current)
        setError("The source chat is unavailable. No chat was forgotten.");
    } finally {
      if (generation.current === current) {
        busy.current = false;
        setBusyId(null);
      }
    }
  };

  if (!actions.length && !error) return null;
  return (
    <section className="hq-managed-memory-actions" aria-label="Memory actions">
      {error ? <p role="alert">{error}</p> : null}
      {actions.map((action) => (
        <div key={action.id} className="hq-managed-memory-action">
          <p>{action.message}</p>
          {action.outcome === "forgotten" && action.assertionId ? (
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void undo(action)}
            >
              {busyId === action.id ? "Restoring…" : "Undo"}
            </button>
          ) : null}
          {action.outcome === "offer_chat_forget" &&
          action.sourceSessionId &&
          onOfferChatForget ? (
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => void offerChatForget(action)}
            >
              Review chat Forget
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
