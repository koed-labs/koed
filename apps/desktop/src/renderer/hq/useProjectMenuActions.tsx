import type { Project } from "@koed/shared/project-contract";
import type { ProjectsDesktopApi } from "../../ipc/projects-protocol.js";
import type { ProjectsStore } from "./useProjects.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from "react";

type Preview = Awaited<ReturnType<ProjectsDesktopApi["deletePreview"]>>;
type DeleteStatus = NonNullable<
  Awaited<ReturnType<ProjectsDesktopApi["deleteStatus"]>>
>;
type DeleteIntent = {
  preview: Preview;
  batchId: string;
  submitted: boolean;
  status: DeleteStatus | null;
  error: string | null;
};
type AuthorityToken = {
  ownerId: string | null | undefined;
  profileKey: string | null | undefined;
  epoch: number;
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function useProjectMenuActions({
  api,
  store,
  ownerId,
  profileKey,
  suggestedProjectName,
  onOpenProject
}: {
  api: ProjectsDesktopApi | null | undefined;
  store: ProjectsStore | null;
  ownerId: string | null | undefined;
  profileKey: string | null | undefined;
  suggestedProjectName?: string;
  onOpenProject: (projectId: string) => void;
}): {
  openCreate: () => void;
  openDelete: (
    projectId: string,
    textAction?: {
      actionId: string;
      expectedVersion: number;
      expectedExecutionSetHash: string;
    }
  ) => void;
  ui: ReactNode;
} {
  const [create, setCreate] = useState<{
    key: string;
    name: string;
    folderPath: string | null;
    submitted: boolean;
    error: string | null;
    busy: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<DeleteIntent | null>(null);
  const [loadingDelete, setLoadingDelete] = useState(false);
  const [deleteLoadError, setDeleteLoadError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const busy = useRef(false);
  const intentEpoch = useRef(0);
  const authority = useRef({ ownerId, profileKey });
  authority.current = { ownerId, profileKey };
  const capture = (): AuthorityToken => ({
    ownerId,
    profileKey,
    epoch: intentEpoch.current
  });
  const current = useCallback(
    (expected: AuthorityToken) =>
      intentEpoch.current === expected.epoch &&
      authority.current.ownerId === expected.ownerId &&
      authority.current.profileKey === expected.profileKey &&
      store?.current().ownerId === expected.ownerId &&
      store?.current().profileKey === expected.profileKey,
    [store]
  );
  const returnFocus = () =>
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus();
    });
  useEffect(() => {
    intentEpoch.current++;
    setCreate(null);
    setDeleting(null);
    setDeleteLoadError(null);
    setLoadingDelete(false);
    setRestoring(false);
    busy.current = false;
  }, [ownerId, profileKey]);
  useEffect(() => {
    if (create || deleting || loadingDelete)
      dialog.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, [create?.key, deleting?.batchId, loadingDelete]);

  const openCreate = () => {
    if (!api || !store || !ownerId || !profileKey) return;
    intentEpoch.current++;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCreate({
      key: crypto.randomUUID(),
      name: suggestedProjectName ?? "",
      folderPath: null,
      submitted: false,
      error: null,
      busy: false
    });
  };
  const pickFolder = async () => {
    if (!api || !create || create.submitted || busy.current) return;
    const expected = capture();
    const key = create.key;
    try {
      const path = await api.pickFolder();
      if (path && current(expected))
        setCreate((value) =>
          value?.key === key ? { ...value, folderPath: path } : value
        );
    } catch (error) {
      if (current(expected))
        setCreate((value) =>
          value?.key === key
            ? {
                ...value,
                error: `Folder could not be selected: ${message(error)}`
              }
            : value
        );
    }
  };
  const openDelete = (
    projectId: string,
    textAction?: {
      actionId: string;
      expectedVersion: number;
      expectedExecutionSetHash: string;
    }
  ) => {
    if (!api || !store || !ownerId || !profileKey || busy.current) return;
    intentEpoch.current++;
    const expected = capture();
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setDeleteLoadError(null);
    setLoadingDelete(true);
    void api
      .deletePreview(projectId)
      .then((preview) => {
        if (!current(expected)) return;
        if (preview.project.lifecycle !== "active")
          throw new Error("Project is unavailable for deletion.");
        if (
          textAction &&
          (preview.project.version !== textAction.expectedVersion ||
            preview.executionSetHash !== textAction.expectedExecutionSetHash)
        )
          throw new Error(
            "Project changed since the Koed action was proposed."
          );
        setDeleting({
          preview,
          batchId: textAction?.actionId ?? crypto.randomUUID(),
          submitted: false,
          status: null,
          error: null
        });
      })
      .catch((error) => {
        if (current(expected))
          setDeleteLoadError(
            `Project details could not be loaded: ${message(error)}`
          );
      })
      .finally(() => {
        if (current(expected)) setLoadingDelete(false);
      });
  };
  const updateStatus = useCallback(
    (status: DeleteStatus, expected: AuthorityToken) => {
      if (!current(expected)) return;
      setDeleting((intent) =>
        intent && intent.batchId === status.operation?.batchId
          ? { ...intent, status, error: null }
          : intent
      );
      if (status.complete && status.project.lifecycle === "deleted") {
        store?.projectChanged(
          expected.ownerId!,
          expected.profileKey!,
          status.project.id,
          status.project
        );
        void store?.refresh();
      } else if (
        status.operation?.state === "restored" &&
        status.project.lifecycle === "active" &&
        !status.cancellationPending
      ) {
        store?.projectChanged(
          expected.ownerId!,
          expected.profileKey!,
          status.project.id,
          status.project
        );
        void store?.refresh();
        setDeleting(null);
        returnFocus();
      }
    },
    [current, store]
  );
  const reconcile = async (intent: DeleteIntent, expected: AuthorityToken) => {
    try {
      const status = await api!.deleteStatus(
        intent.preview.project.id,
        intent.batchId
      );
      if (status) updateStatus(status, expected);
      else if (current(expected))
        setDeleting((value) =>
          value && value.batchId === intent.batchId
            ? {
                ...value,
                submitted: false,
                status: null,
                error:
                  "No delete batch was found. Review the Project and try again."
              }
            : value
        );
    } catch (error) {
      if (current(expected))
        setDeleting((value) =>
          value && value.batchId === intent.batchId
            ? {
                ...value,
                error: `Could not verify the delete batch. Retry status check: ${message(error)}`
              }
            : value
        );
    }
  };
  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || !create || busy.current) return;
    const name = create.name.trim();
    if (!name) return;
    const expected = capture();
    busy.current = true;
    setCreate({ ...create, submitted: true, busy: true, error: null });
    try {
      const project: Project = await api.create({
        name,
        folderPath: create.folderPath,
        idempotencyKey: create.key
      });
      if (!current(expected)) return;
      store?.projectChanged(
        expected.ownerId!,
        expected.profileKey!,
        project.id,
        project
      );
      await store?.refresh();
      if (!current(expected)) return;
      setCreate(null);
      onOpenProject(project.id);
      returnFocus();
    } catch (error) {
      if (current(expected))
        setCreate((value) =>
          value && value.key === create.key
            ? {
                ...value,
                busy: false,
                error: `Project creation could not be confirmed. Retry uses the same request: ${message(error)}`
              }
            : value
        );
    } finally {
      if (current(expected)) busy.current = false;
    }
  };
  const confirmDelete = async () => {
    if (!api || !deleting || deleting.submitted || busy.current) return;
    const intent = deleting;
    const expected = capture();
    let dispatched = false;
    busy.current = true;
    setDeleting({ ...intent, error: null });
    try {
      const latest = await api.deletePreview(intent.preview.project.id);
      if (!current(expected)) return;
      if (
        latest.project.version !== intent.preview.project.version ||
        latest.executionSetHash !== intent.preview.executionSetHash
      ) {
        setDeleting({
          ...intent,
          preview: latest,
          error: "Project contents changed. Review this confirmation again."
        });
        return;
      }
      setDeleting({ ...intent, submitted: true, error: null });
      dispatched = true;
      const status = await api.delete(intent.preview.project.id, {
        version: latest.project.version,
        batchId: intent.batchId,
        executionSetHash: latest.executionSetHash
      });
      updateStatus(status, expected);
    } catch (error) {
      if (current(expected)) {
        setDeleting((value) =>
          value && value.batchId === intent.batchId
            ? {
                ...value,
                error: dispatched
                  ? `Delete response was uncertain: ${message(error)}`
                  : `Project details could not be verified: ${message(error)}`
              }
            : value
        );
        if (dispatched) await reconcile(intent, expected);
      }
    } finally {
      if (current(expected)) busy.current = false;
    }
  };
  useEffect(() => {
    if (
      !deleting?.status ||
      deleting.status.complete ||
      !deleting.status.retryable ||
      deleting.status.pendingReviews.length ||
      deleting.status.cancellationPending
    )
      return;
    const intent = deleting;
    const expected = capture();
    const timer = window.setTimeout(() => {
      if (busy.current || !current(expected)) return;
      busy.current = true;
      void api!
        .deleteProgress(intent.preview.project.id, intent.batchId)
        .then((status) => updateStatus(status, expected))
        .catch(() => reconcile(intent, expected))
        .finally(() => {
          if (current(expected)) busy.current = false;
        });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [api, current, deleting, ownerId, profileKey, updateStatus]);
  const cancelDelete = async () => {
    if (!api || !deleting || busy.current || deleting.status?.complete) return;
    if (!deleting.status) {
      if (deleting.submitted) await reconcile(deleting, capture());
      else {
        setDeleting(null);
        returnFocus();
      }
      return;
    }
    const intent = deleting;
    const expected = capture();
    busy.current = true;
    try {
      const status = await api.deleteCancel(
        intent.preview.project.id,
        intent.batchId
      );
      updateStatus(status, expected);
      if (current(expected) && !status.cancellationPending) {
        setDeleting(null);
        returnFocus();
      }
    } catch {
      await reconcile(intent, expected);
    } finally {
      if (current(expected)) busy.current = false;
    }
  };
  const continueDelete = async () => {
    if (
      !api ||
      !deleting?.submitted ||
      !deleting.status ||
      deleting.status.complete ||
      deleting.status.operation?.state === "cancelled" ||
      deleting.status.cancellationPending ||
      busy.current
    )
      return;
    const intent = deleting;
    const expected = capture();
    busy.current = true;
    try {
      const status = await api.deleteProgress(
        intent.preview.project.id,
        intent.batchId
      );
      if (!current(expected)) return;
      updateStatus(status, expected);
    } catch (error) {
      if (!current(expected)) return;
      setDeleting((value) =>
        value?.batchId === intent.batchId
          ? {
              ...value,
              error: `Deletion could not be advanced: ${message(error)}`
            }
          : value
      );
      await reconcile(intent, expected);
    } finally {
      if (current(expected)) busy.current = false;
    }
  };
  const undoDelete = async () => {
    if (!api || !deleting?.status || busy.current) return;
    const intent = deleting;
    const expected = capture();
    busy.current = true;
    setRestoring(true);
    try {
      const latest = await api.deleteStatus(
        intent.preview.project.id,
        intent.batchId
      );
      if (!current(expected)) return;
      if (!latest) throw new Error("Delete batch could not be verified.");
      if (latest.complete && latest.project.lifecycle === "deleted") {
        await api.restore(intent.preview.project.id, {
          version: latest.project.version,
          batchId: intent.batchId
        });
        if (!current(expected)) return;
      } else if (
        latest.operation?.state !== "restored" &&
        latest.operation?.state !== "restore_releasing"
      )
        throw new Error("Project restore state changed. Check status.");
      const reconciled = await api.restoreReconcile(
        intent.preview.project.id,
        intent.batchId
      );
      if (!current(expected)) return;
      if (!reconciled.released) {
        setDeleting({
          ...intent,
          status: {
            ...latest,
            project: reconciled.project,
            operation: { batchId: intent.batchId, state: "restore_releasing" },
            complete: false,
            cancellationPending: true
          },
          error: "Restore is finishing. Check again."
        });
        return;
      }
      store?.projectChanged(
        expected.ownerId!,
        expected.profileKey!,
        reconciled.project.id,
        reconciled.project
      );
      await store?.refresh();
      if (!current(expected)) return;
      setDeleting(null);
      returnFocus();
    } catch (error) {
      if (current(expected)) {
        setDeleting({
          ...intent,
          error: `Restore could not be confirmed: ${message(error)}`
        });
        await reconcile(intent, expected);
      }
    } finally {
      if (current(expected)) {
        busy.current = false;
        setRestoring(false);
      }
    }
  };
  const close = () => {
    if (busy.current || (deleting?.submitted && !deleting.status)) return;
    intentEpoch.current++;
    setCreate(null);
    setDeleting(null);
    setDeleteLoadError(null);
    setLoadingDelete(false);
    returnFocus();
  };
  const onDialogKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (
        deleting &&
        (!deleting.status?.complete || (deleting.submitted && !deleting.status))
      )
        void cancelDelete();
      else close();
    }
    if (event.key !== "Tab" || !dialog.current) return;
    const items = [
      ...dialog.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])"
      )
    ];
    if (!items.length) return;
    const first = items[0]!,
      last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const completedDelete =
    deleting?.status?.complete &&
    deleting.status.project.lifecycle === "deleted";
  const ui = completedDelete ? (
    <div className="hq-project-toast" data-hq-shell="" role="status">
      <span>{deleting.preview.project.name} moved to Deleted.</span>
      {deleting.error ? (
        <span className="hq-project-toast__error">{deleting.error}</span>
      ) : null}
      <button
        type="button"
        onClick={() => void undoDelete()}
        disabled={restoring}
      >
        Undo
      </button>
      <button
        type="button"
        onClick={close}
        aria-label="Dismiss Project deletion notice"
      >
        ×
      </button>
    </div>
  ) : create || deleting || loadingDelete || deleteLoadError ? (
    <div
      className="hq-project-modal-backdrop"
      data-hq-shell=""
      onPointerDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (!deleting || (!deleting.status && !deleting.submitted))
        )
          close();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={create ? "New Project" : "Delete Project"}
        className="hq-project-modal"
        onKeyDown={onDialogKeyDown}
      >
        {create ? (
          <form onSubmit={(event) => void submitCreate(event)}>
            <h2>New Project</h2>
            <label htmlFor="hq-new-project-name">Name</label>
            <input
              id="hq-new-project-name"
              value={create.name}
              maxLength={200}
              placeholder="Name your project"
              disabled={create.submitted}
              onChange={(event) =>
                setCreate({ ...create, name: event.target.value, error: null })
              }
              autoFocus
            />
            <label className="hq-project-modal__folder-label">
              Folder (optional)
            </label>
            <div className="hq-project-modal__folder">
              <span>
                {create.folderPath ?? "No folder. Chats and memory only."}
              </span>
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={create.submitted}
              >
                {create.folderPath ? "Change" : "Choose folder…"}
              </button>
              {create.folderPath ? (
                <button
                  type="button"
                  aria-label="Remove folder"
                  disabled={create.submitted}
                  onClick={() => setCreate({ ...create, folderPath: null })}
                >
                  ×
                </button>
              ) : null}
            </div>
            {create.error ? (
              <p role="alert" className="hq-project-modal__error">
                {create.error}
              </p>
            ) : null}
            <div className="hq-project-modal__actions">
              <button type="button" onClick={close} disabled={create.busy}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={create.busy || !create.name.trim()}
              >
                Create project
              </button>
            </div>
          </form>
        ) : loadingDelete ? (
          <p>Loading Project details…</p>
        ) : deleteLoadError ? (
          <>
            <h2>Project unavailable</h2>
            <p role="alert">{deleteLoadError}</p>
            <div className="hq-project-modal__actions">
              <button type="button" onClick={close}>
                Close
              </button>
            </div>
          </>
        ) : deleting ? (
          <>
            <h2>
              {deleting.status?.operation?.state === "restored" ||
              deleting.status?.operation?.state === "restore_releasing"
                ? `Restoring ${deleting.preview.project.name}`
                : `Delete ${deleting.preview.project.name}?`}
            </h2>
            <p>
              Its chats, to-dos and docs move to Deleted for 30 days. Koed keeps
              what it learned.
            </p>
            {deleting.status && !deleting.status.complete ? (
              <p role="status">
                {deleting.status.pendingReviews.length
                  ? "Deletion is waiting for approval."
                  : deleting.status.cancellationPending
                    ? "Cancellation is finishing."
                    : `Deleting Project: ${deleting.status.operation?.state ?? "checking"}…`}
              </p>
            ) : null}
            {deleting.error ? (
              <p role="alert" className="hq-project-modal__error">
                {deleting.error}
              </p>
            ) : null}
            <div className="hq-project-modal__actions">
              {deleting.status?.complete &&
              deleting.status.project.lifecycle === "deleted" ? (
                <>
                  <button type="button" onClick={close}>
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => void undoDelete()}
                    disabled={restoring}
                  >
                    Undo
                  </button>
                </>
              ) : deleting.status?.operation?.state === "restored" ||
                deleting.status?.operation?.state === "restore_releasing" ? (
                <button
                  type="button"
                  onClick={() => void undoDelete()}
                  disabled={restoring}
                >
                  Check restore
                </button>
              ) : deleting.status?.operation?.state === "cancelled" ? (
                deleting.status.cancellationPending ? (
                  <button
                    type="button"
                    onClick={() => void cancelDelete()}
                    disabled={busy.current}
                  >
                    Check cancellation
                  </button>
                ) : (
                  <button type="button" onClick={close}>
                    Close
                  </button>
                )
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void cancelDelete()}
                    disabled={busy.current}
                  >
                    Cancel
                  </button>
                  {deleting.submitted ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void reconcile(deleting, capture())}
                      >
                        Check status
                      </button>
                      {deleting.status?.pendingReviews.length ? (
                        <button
                          type="button"
                          onClick={() => void continueDelete()}
                          disabled={busy.current}
                        >
                          Check approval
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="hq-project-modal__danger"
                      onClick={() => void confirmDelete()}
                    >
                      Delete project
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  ) : null;
  return { openCreate, openDelete, ui };
}
