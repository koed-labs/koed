import { useEffect, useRef, useState } from "react";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";

type DeletedChat = Awaited<
  ReturnType<NonNullable<PersonalDesktopApi["listDeletedSessions"]>>
>["sessions"][number];

export function HqSettingsDeleted({
  api,
  authorityKey,
  onRestored
}: {
  api?: PersonalDesktopApi;
  authorityKey?: string;
  onRestored?: (sessionId: string, batchId: string | null) => void;
}) {
  const [rows, setRows] = useState<DeletedChat[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const busy = useRef(false);
  const activeAuthorityKey = useRef(authorityKey);
  activeAuthorityKey.current = authorityKey;
  const refresh = async () => {
    if (!api?.listDeletedSessions) {
      setLoading(false);
      return;
    }
    const expected = generation.current;
    const expectedAuthority = authorityKey;
    try {
      const page = await api.listDeletedSessions();
      if (
        expected !== generation.current ||
        expectedAuthority !== activeAuthorityKey.current
      )
        return;
      setRows(page.sessions);
      setNextCursor(page.nextCursor);
      setError("");
    } catch (cause) {
      if (
        expected !== generation.current ||
        expectedAuthority !== activeAuthorityKey.current
      )
        return;
      setError(
        cause instanceof Error ? cause.message : "Could not load Deleted chats."
      );
    } finally {
      if (
        expected === generation.current &&
        expectedAuthority === activeAuthorityKey.current
      )
        setLoading(false);
    }
  };
  const loadMore = async () => {
    if (!api?.listDeletedSessions || !nextCursor || busy.current) return;
    busy.current = true;
    const expected = generation.current;
    const expectedAuthority = authorityKey;
    const cursor = nextCursor;
    try {
      const page = await api.listDeletedSessions({ cursor });
      if (
        expected !== generation.current ||
        expectedAuthority !== activeAuthorityKey.current
      )
        return;
      setRows((current) => [...current, ...page.sessions]);
      setNextCursor(page.nextCursor);
      setError("");
    } catch (cause) {
      if (
        expected !== generation.current ||
        expectedAuthority !== activeAuthorityKey.current
      )
        return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load more Deleted chats."
      );
    } finally {
      if (
        expected === generation.current &&
        expectedAuthority === activeAuthorityKey.current
      )
        busy.current = false;
    }
  };
  useEffect(() => {
    generation.current++;
    setRows([]);
    setNextCursor(null);
    setLoading(true);
    void refresh();
    return () => {
      generation.current++;
      busy.current = false;
    };
  }, [api, authorityKey]);
  const restore = async (sessionId: string, batchId: string | null) => {
    if (!api?.restoreSession || busy.current) return;
    busy.current = true;
    const expected = generation.current;
    const expectedAuthority = authorityKey;
    try {
      await api.restoreSession({ sessionId, batchId: batchId ?? undefined });
      if (
        expected !== generation.current ||
        expectedAuthority !== activeAuthorityKey.current
      )
        return;
      await refresh();
      if (
        expected === generation.current &&
        expectedAuthority === activeAuthorityKey.current
      )
        onRestored?.(sessionId, batchId);
    } catch (cause) {
      if (
        expected !== generation.current ||
        expectedAuthority !== activeAuthorityKey.current
      )
        return;
      setError(
        cause instanceof Error ? cause.message : "Could not restore this chat."
      );
    } finally {
      if (
        expected === generation.current &&
        expectedAuthority === activeAuthorityKey.current
      )
        busy.current = false;
    }
  };
  return (
    <section className="hq-settings__group" aria-label="Deleted chats">
      <h3>Deleted chats</h3>
      <p>
        Chats can be restored for 30 days. Their memory stays available unless
        you forget the chat.
      </p>
      {loading ? <p>Loading…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!loading && rows.length === 0 ? <p>No deleted chats.</p> : null}
      <ul className="hq-settings__deleted-list">
        {rows.map((row) => (
          <li key={row.sessionId}>
            <span>{row.title}</span>
            <button
              type="button"
              onClick={() => void restore(row.sessionId, row.batchId)}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <button type="button" onClick={() => void loadMore()}>
          Load more deleted chats
        </button>
      ) : null}
    </section>
  );
}
