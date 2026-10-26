import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Button,
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from "@koed/ui";
import type {
  PersonalDesktopApi,
  PersonalDesktopProject,
  PersonalDesktopProjectThread
} from "@koed/shared/personal-desktop";
import { ArrowRight, FilePenLine, Folder, GitFork } from "lucide-react";
import {
  SourceContextStatus,
  SourceCorrectionImpact,
  effective,
  factLabel,
  type SourceContext as Context
} from "./SourceContextCompare.js";
import "./conversation-cards.css";
import { repositoryScopeId } from "@koed/shared/repository-recall";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";

type Manage = NonNullable<PersonalDesktopApi["manageSourceContext"]>;
type Result = Awaited<ReturnType<Manage>>;
export function SourceContextCorrectionDialog({
  thread,
  projects,
  manage,
  store,
  menuitem = false,
  open: controlledOpen,
  onOpenChange,
  returnFocus
}: {
  thread: Pick<PersonalDesktopProjectThread, "sessionId" | "name">;
  projects: readonly PersonalDesktopProject[];
  manage: Manage;
  store: PersonalMemoryStore;
  menuitem?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const [localOpen, setLocalOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [context, setContext] = useState<Context | null>(null),
    [preview, setPreview] = useState<Result["preview"]>();
  const [axis, setAxis] = useState<"git" | "folder">("git"),
    [target, setTarget] = useState("reset");
  const running = useRef(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  useEffect(() => {
    if (controlledOpen && thread.sessionId) void load();
  }, [controlledOpen, thread.sessionId]);
  if (!thread.sessionId) return null;
  const repositories = new Map<
    string,
    Extract<Context["git"]["original"], { state: "known" }>["value"]
  >();
  const folders = new Map<
    string,
    Extract<Context["folder"]["original"], { state: "known" }>["value"]
  >();
  for (const project of projects) {
    if (
      project.repository?.kind === "portable_repository" ||
      project.repository?.kind === "device_local_repository"
    )
      repositories.set(
        repositoryScopeId(project.repository),
        project.repository
      );
    if (project.folder)
      folders.set(JSON.stringify(project.folder.reference), project.folder);
  }
  if (context) {
    for (const fact of [context.git.original, effective(context.git)])
      if (fact.state === "known")
        repositories.set(repositoryScopeId(fact.value), fact.value);
    for (const fact of [context.folder.original, effective(context.folder)])
      if (fact.state === "known")
        folders.set(JSON.stringify(fact.value.reference), fact.value);
  }
  if (context?.sync) {
    for (const head of context.sync.git.heads)
      for (const fact of [head.assignment.original, effective(head.assignment)])
        if (fact.state === "known")
          repositories.set(repositoryScopeId(fact.value), fact.value);
    for (const head of context.sync.folder.heads)
      for (const fact of [head.assignment.original, effective(head.assignment)])
        if (fact.state === "known")
          folders.set(JSON.stringify(fact.value.reference), fact.value);
  }
  const syncPending =
    context?.sync?.availability === "pending" ||
    context?.sync?.[axis].state === "pending";
  const choices =
    axis === "git"
      ? [...repositories.entries()].map(([id, value]) => ({
          id,
          label: value.anchorDisplay ?? value.key
        }))
      : [...folders.entries()].map(([id, value]) => ({
          id,
          label: factLabel({ state: "known", value })
        }));
  const load = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setContext(null);
    setAxis("git");
    setTarget("reset");
    try {
      setContext(
        (await manage({ action: "get", sessionId: thread.sessionId! })).context
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const review = async () => {
    if (!context || syncPending || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setPreview(undefined);
    try {
      const expectedVersion =
        axis === "git" ? context.git.revision : context.folder.revision;
      const correction =
        target === "reset" || target === "unresolved"
          ? ({ axis, action: target, expectedVersion } as const)
          : axis === "git"
            ? {
                axis,
                action: "set" as const,
                expectedVersion,
                repository: repositories.get(target)!
              }
            : {
                axis,
                action: "set" as const,
                expectedVersion,
                folder: folders.get(target)!.reference
              };
      const result = await manage({
        action: "preview",
        sessionId: thread.sessionId!,
        correction
      });
      if (
        !result.preview ||
        result.context.sessionId !== thread.sessionId ||
        result.preview.axis !== axis ||
        result.preview.expectedVersion !== expectedVersion
      )
        throw new Error(
          "Correction preview could not be verified. Review it again."
        );
      setContext(result.context);
      setPreview(result.preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await manage({
        action: "apply",
        sessionId: thread.sessionId!,
        reviewId: preview.reviewId,
        expectedVersion: preview.expectedVersion
      });
      setContext(result.context);
      setPreview(undefined);
      const refreshed = await store.loadProjects({ silent: true });
      if (refreshed.error) throw new Error(refreshed.error);
      setOpen(false);
    } catch (cause) {
      setPreview(undefined);
      setError(cause instanceof Error ? cause.message : String(cause));
      try {
        setContext(
          (await manage({ action: "get", sessionId: thread.sessionId! }))
            .context
        );
      } catch {
        setContext(null);
      }
      await store.loadProjects({ silent: true });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const openDialog = () => {
    setOpen(true);
    void load();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      {controlledOpen !== undefined ? null : menuitem ? (
        <button type="button" role="menuitem" onClick={openDialog}>
          <FilePenLine aria-hidden="true" />
          Correct source context
        </button>
      ) : (
        <Button variant="outline" onClick={openDialog}>
          Correct source context
        </Button>
      )}
      <DialogPopup
        className="personal-conversation-card personal-source-context-card"
        finalFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>Correct source context</DialogTitle>
          <DialogDescription>{thread.name}</DialogDescription>
        </DialogHeader>
        <div className="personal-conversation-card-body" aria-busy={busy}>
          {context ? (
            <>
              <nav
                className="personal-source-context-tabs"
                aria-label="Context to correct"
              >
                {(["git", "folder"] as const).map((kind) => (
                  <Button
                    key={kind}
                    variant="ghost"
                    aria-pressed={axis === kind}
                    disabled={busy}
                    onClick={() => {
                      setAxis(kind);
                      setTarget("reset");
                      setPreview(undefined);
                      setError("");
                    }}
                  >
                    {kind === "git" ? (
                      <GitFork aria-hidden="true" />
                    ) : (
                      <Folder aria-hidden="true" />
                    )}
                    {kind === "git" ? "Git Anchor" : "Folder"}
                  </Button>
                ))}
              </nav>
              <div className="personal-source-comparison">
                <section
                  className="personal-source-current"
                  aria-label="Current source context"
                >
                  <span>
                    Current {axis === "git" ? "Git Anchor" : "Folder"}
                  </span>
                  <strong>
                    {factLabel(
                      effective<Context[typeof axis]["original"]>(context[axis])
                    )}
                  </strong>
                  <small>
                    Recorded original · {factLabel(context[axis].original)}
                  </small>
                </section>
                <ArrowRight
                  className="personal-source-comparison-arrow"
                  aria-hidden="true"
                />
                <section className="personal-source-correction">
                  <label>
                    Correct to
                    <select
                      aria-label="Correction"
                      value={target}
                      disabled={busy || syncPending}
                      onChange={(event) => {
                        setTarget(event.target.value);
                        setPreview(undefined);
                        setError("");
                      }}
                    >
                      <option value="reset">Reset to recorded original</option>
                      <option value="unresolved">Mark unresolved</option>
                      {choices.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {preview ? (
                    <small>
                      After correction ·{" "}
                      {factLabel(
                        effective<Context[typeof axis]["original"]>(
                          preview.after[axis]
                        )
                      )}
                    </small>
                  ) : null}
                </section>
              </div>
              <SourceContextStatus context={context} />
              {preview ? <SourceCorrectionImpact preview={preview} /> : null}
            </>
          ) : busy ? (
            <p role="status">Loading source context…</p>
          ) : null}
          {error ? (
            <p className="personal-conversation-card-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !context || syncPending}
            onClick={() => void (preview ? apply() : review())}
          >
            {preview ? "Confirm" : "Review changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
