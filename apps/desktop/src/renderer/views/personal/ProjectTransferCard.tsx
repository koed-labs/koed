import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Folder,
  GitFork,
  MessagesSquare
} from "lucide-react";
import { Button } from "@koed/ui";
import { personalInventoryConversationKey } from "@koed/shared/personal-desktop";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopProject } from "../../../project-memory-ui.js";
import type { PersonalMemoryStore } from "../../state/personal-memory.js";
import {
  hasTransferInclusion,
  projectTransferInclusions,
  projectTransferSources,
  type TransferSource
} from "./project-transfer-model.js";
import { ProjectTransferNavigation } from "./ProjectTransferNavigation.js";
import { useProjectTransferDraft } from "./use-project-transfer-draft.js";
import { useProjectTransfer } from "./use-project-transfer.js";
import "./project-transfer.css";

type Props = {
  project: DesktopProject;
  projects: readonly DesktopProject[];
  manage: NonNullable<PersonalDesktopApi["manageProject"]>;
  store: PersonalMemoryStore;
  heading?: (id: string) => ReactNode;
  closeControl?: ReactNode;
  onCancel: () => void;
  onConfirmed: () => void;
  onBusyChange?: (busy: boolean) => void;
};
const sourceIcon = (kind: TransferSource["kind"]) =>
  kind === "repository" ? GitFork : kind === "folder" ? Folder : MessagesSquare;

export function ProjectTransferCard({
  project,
  projects,
  manage,
  store,
  heading,
  closeControl,
  onBusyChange,
  onCancel,
  onConfirmed
}: Props) {
  const headingId = useId();
  const sources = useMemo(() => projectTransferSources(projects), [projects]);
  const initialInclusions = useMemo(
    () => projectTransferInclusions(project, sources),
    [project, sources]
  );
  const draft = useProjectTransferDraft(
    initialInclusions,
    project.namedProject!.version
  );
  const inclusions = draft.inclusions.map((row) => {
    const current = [
      ...sources.repositories,
      ...sources.folders,
      ...sources.conversations
    ].find((candidate) => hasTransferInclusion(candidate, [row]));
    return { ...row, threads: current?.threads ?? [] };
  });
  const [rightTab, setRightTab] = useState<"all" | "repository" | "folder">(
    "all"
  );
  const [rightPath, setRightPath] = useState<TransferSource[]>([]);
  const rightList = useRef<HTMLDivElement>(null);
  const rightBreadcrumb = useRef<HTMLElement>(null);
  const rightChangedPath = useRef(false);
  const [tab, setTab] = useState<"repository" | "folder">("repository");
  const [path, setPath] = useState<TransferSource[]>([]);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [right, setRight] = useState<Set<string>>(new Set());
  const leftList = useRef<HTMLDivElement>(null);
  const breadcrumb = useRef<HTMLElement>(null);
  const changedPath = useRef(false);
  const transfer = useProjectTransfer(project, manage, store);
  useEffect(() => {
    onBusyChange?.(transfer.busy);
  }, [transfer.busy, onBusyChange]);
  // Re-resolve browsed identities after capture/sync refresh instead of retaining
  // the old row's source list. Deleted or corrected sources cannot linger here.
  const rootRows =
    tab === "repository" ? sources.repositories : sources.folders;
  const rootSource = rootRows.find((row) => row.id === path[0]?.id);
  const second =
    rootSource && path[1]
      ? sources.children(rootSource).find((row) => row.id === path[1]!.id)
      : undefined;
  const currentPath = rootSource
    ? second
      ? [rootSource, second]
      : [rootSource]
    : [];
  const current = currentPath.at(-1);
  const rows = current
    ? sources.children(current, currentPath.length > 1 ? rootSource : undefined)
    : rootRows;
  const selectedLeft = rows.filter(
    (row) => left.has(row.id) && !hasTransferInclusion(row, inclusions)
  );
  // Only effective Project Conversations appear beneath a saved rule. Source
  // identities, not directory strings, determine each navigation boundary.
  const effective = new Set(
    project.threads.flatMap((thread) => [
      thread.sessionId,
      ...(thread.sourceReferences?.map((ref) => ref.sessionId) ?? [])
    ])
  );
  const includedChildren = (
    source: TransferSource,
    repository?: TransferSource
  ) =>
    sources
      .children(source, repository)
      .map((row) => ({
        ...row,
        threads: row.threads.filter(
          (thread) =>
            effective.has(thread.sessionId) ||
            thread.sourceReferences?.some((ref) => effective.has(ref.sessionId))
        )
      }))
      .filter(
        (row) =>
          row.threads.length &&
          !draft.excluded.some((entry) => entry.id === row.id)
      );
  const folderRoots = new Map<string, TransferSource>();
  for (const row of inclusions.filter((entry) => entry.kind === "repository")) {
    for (const child of includedChildren(row)) folderRoots.set(child.id, child);
  }
  for (const row of inclusions.filter((entry) => entry.kind === "folder")) {
    const source = sources.folders.find((entry) =>
      hasTransferInclusion(entry, [row])
    );
    folderRoots.set(source?.id ?? row.id, row);
  }
  const rightRoots =
    rightTab === "folder"
      ? [...folderRoots.values()]
      : inclusions.filter((row) => rightTab === "all" || row.kind === rightTab);
  const rightRoot = rightRoots.find((row) => row.id === rightPath[0]?.id);
  const rightSecond =
    rightRoot && rightPath[1]
      ? includedChildren(rightRoot).find((row) => row.id === rightPath[1]!.id)
      : undefined;
  const currentRightPath = rightRoot
    ? rightSecond
      ? [rightRoot, rightSecond]
      : [rightRoot]
    : [];
  const rightCurrent = currentRightPath.at(-1);
  const rightRows = rightCurrent
    ? includedChildren(
        rightCurrent,
        currentRightPath.length > 1 ? rightRoot : undefined
      )
    : rightRoots;
  const selectedRight = rightRows.filter((row) => right.has(row.id));
  const rightBrowseKey = `${rightTab}:${currentRightPath.map((row) => row.id).join("/")}`;
  useLayoutEffect(() => {
    if (rightList.current) rightList.current.scrollTop = 0;
    if (rightChangedPath.current)
      rightBreadcrumb.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    rightChangedPath.current = false;
  }, [rightBrowseKey]);
  const browseRight = (next: TransferSource[]) => {
    setRightPath(next);
    setRight(new Set());
    rightChangedPath.current = true;
  };
  const browseKey = `${tab}:${currentPath.map((row) => row.id).join("/")}`;
  useLayoutEffect(() => {
    if (leftList.current) leftList.current.scrollTop = 0;
    if (changedPath.current)
      breadcrumb.current?.querySelector<HTMLButtonElement>("button")?.focus();
    changedPath.current = false;
  }, [browseKey]);
  const browse = (next: TransferSource[]) => {
    setPath(next);
    setLeft(new Set());
    changedPath.current = true;
  };
  const toggle = (id: string, side: "left" | "right") => {
    const update = side === "left" ? setLeft : setRight;
    update((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const include = () => {
    const additions = selectedLeft.flatMap((row) =>
      row.kind === "folder" && !row.target ? sources.children(row) : [row]
    );
    draft.include([...new Map(additions.map((row) => [row.id, row])).values()]);
    setLeft(new Set());
    setRight(new Set());
  };
  const remove = () => {
    draft.remove(selectedRight);
    setLeft(new Set());
    setRight(new Set());
  };

  const previewReasons = new Map<string, number>();
  const excludedKeys = new Set(
    draft.excluded.flatMap((row) =>
      row.threads.map(personalInventoryConversationKey)
    )
  );
  for (const row of inclusions)
    for (const thread of row.threads) {
      const key = personalInventoryConversationKey(thread);
      if (excludedKeys.has(key)) continue;
      previewReasons.set(key, (previewReasons.get(key) ?? 0) + 1);
    }
  const overlapping = [...previewReasons.values()].filter(
    (count) => count > 1
  ).length;

  const confirm = async () => {
    if (
      !draft.commands.length ||
      (await transfer.commit(draft.commands, draft.version))
    )
      onConfirmed();
  };

  return (
    <section
      className="personal-project-transfer"
      aria-labelledby={headingId}
      aria-busy={transfer.busy}
    >
      <div className="personal-transfer-heading">
        {heading ? (
          heading(headingId)
        ) : (
          <h3 id={headingId} className="personal-transfer-sr">
            Project sources
          </h3>
        )}
        {closeControl}
      </div>
      <div className="personal-transfer-board">
        <section
          className="personal-transfer-pane"
          aria-label="Available sources"
        >
          <div className="personal-transfer-pane-heading">
            <span>Available sources</span>
            <span>{rows.length}</span>
          </div>
          <ProjectTransferNavigation
            label="Source path"
            tab={tab}
            path={currentPath}
            busy={transfer.busy}
            navigationRef={breadcrumb}
            onBrowse={browse}
            onTab={(kind) => {
              if (kind !== "all") setTab(kind);
              browse([]);
            }}
          />
          <div
            className="personal-transfer-list"
            role="region"
            aria-label="Available sources list"
            tabIndex={0}
            ref={leftList}
          >
            {rows.length ? (
              rows.map((row) => {
                const included =
                  hasTransferInclusion(row, inclusions) ||
                  (row.kind === "folder" &&
                    !row.target &&
                    row.threads.length > 0 &&
                    sources
                      .children(row)
                      .every((child) =>
                        hasTransferInclusion(child, inclusions)
                      ));
                const Icon = sourceIcon(row.kind);
                const selectable =
                  row.target ||
                  row.sessionId ||
                  (row.kind === "folder" && row.threads.length > 0);
                const children =
                  row.kind === "session"
                    ? []
                    : sources.children(
                        row,
                        row.kind === "repository"
                          ? undefined
                          : rootSource?.kind === "repository"
                            ? rootSource
                            : undefined
                      );
                return (
                  <div className="personal-transfer-row" key={row.id}>
                    <label className="personal-transfer-select">
                      <span className="personal-transfer-sr">
                        Select {row.name}
                      </span>
                      <input
                        type="checkbox"
                        checked={included || left.has(row.id)}
                        disabled={transfer.busy || included || !selectable}
                        onChange={() => toggle(row.id, "left")}
                      />
                    </label>
                    <Icon
                      className="personal-transfer-source-icon"
                      aria-hidden="true"
                    />
                    <div className="personal-transfer-row-copy">
                      <strong>{row.name}</strong>
                      <small title={row.detail}>
                        {row.kind === "repository"
                          ? `${children.filter((child) => child.kind === "folder").length} Folders · ${row.threads.length} Conversations`
                          : row.kind === "folder"
                            ? `${row.threads.length} Conversations · ${row.detail}`
                            : row.detail}
                      </small>
                    </div>
                    {row.kind !== "session" ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="personal-transfer-caret"
                        aria-label={`Browse ${row.kind === "repository" ? "Folders" : "Conversations"} in ${row.name}`}
                        disabled={transfer.busy}
                        onClick={() => browse([...currentPath, row])}
                      >
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="personal-transfer-empty">
                {current
                  ? "No recorded sources at this level."
                  : "No recorded sources yet."}
              </p>
            )}
          </div>
        </section>
        <div className="personal-transfer-arrows">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Include selected in Project"
            title="Include selected in Project"
            disabled={transfer.busy || transfer.failed || !selectedLeft.length}
            onClick={() => void include()}
          >
            <ArrowRight aria-hidden="true" />
          </Button>
          <span aria-hidden="true">
            {selectedLeft.length + selectedRight.length || ""}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Remove selected inclusions"
            title="Remove selected inclusions"
            disabled={transfer.busy || transfer.failed || !selectedRight.length}
            onClick={() => void remove()}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        </div>
        <section
          className="personal-transfer-pane"
          aria-label="In this Project"
        >
          <div className="personal-transfer-pane-heading">
            <span>In this Project</span>
            <span>{inclusions.length} inclusions</span>
          </div>
          <ProjectTransferNavigation
            label="Project inclusion path"
            tab={rightTab}
            path={currentRightPath}
            busy={transfer.busy}
            all
            navigationRef={rightBreadcrumb}
            onBrowse={browseRight}
            onTab={(kind) => {
              setRightTab(kind);
              browseRight([]);
            }}
          />
          <div
            className="personal-transfer-list"
            role="region"
            aria-label="Project inclusions list"
            ref={rightList}
            tabIndex={0}
          >
            {rightRows.length ? (
              rightRows.map((row) => {
                const Icon = sourceIcon(row.kind);
                const explicit = inclusions.some(
                  (entry) => entry.id === row.id
                );
                return (
                  <div className="personal-transfer-row" key={row.id}>
                    <label className="personal-transfer-select">
                      <span className="personal-transfer-sr">
                        {rightCurrent && row.kind === "session"
                          ? "Exclude from Project: "
                          : "Remove inclusion for "}
                        {row.name}
                      </span>
                      <input
                        type="checkbox"
                        checked={right.has(row.id)}
                        disabled={
                          transfer.busy ||
                          (row.kind !== "session" &&
                            !inclusions.some((entry) => entry.id === row.id))
                        }
                        onChange={() => toggle(row.id, "right")}
                      />
                    </label>
                    <Icon
                      className="personal-transfer-source-icon"
                      aria-hidden="true"
                    />
                    <div className="personal-transfer-row-copy">
                      <strong>{row.name}</strong>
                      <small title={row.detail}>
                        {row.kind === "session" || !explicit
                          ? row.detail
                          : "Existing + future Conversations"}
                      </small>
                    </div>
                    {row.kind !== "session" ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="personal-transfer-caret"
                        aria-label={`Browse included ${row.kind === "repository" ? "Folders" : "Conversations"} in ${row.name}`}
                        disabled={transfer.busy}
                        onClick={() => browseRight([...currentRightPath, row])}
                      >
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="personal-transfer-empty">
                {rightCurrent
                  ? "No included Conversations at this level."
                  : "No inclusions at this level."}
              </p>
            )}
          </div>
        </section>
      </div>
      {transfer.error ? (
        <p className="personal-transfer-error" role="alert">
          {transfer.error}
        </p>
      ) : null}
      <p
        className="personal-transfer-preview"
        aria-label="Source change preview"
      >
        {previewReasons.size} distinct recorded source matches · {overlapping}{" "}
        included by more than one source. Source rules include existing and
        future matches. Removing one source preserves other inclusion reasons.
      </p>
      <div className="personal-transfer-footer">
        <Button variant="outline" disabled={transfer.busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={transfer.busy || transfer.failed}
          onClick={() => void confirm()}
        >
          Confirm
        </Button>
      </div>
      <span className="personal-transfer-sr" role="status" aria-live="polite">
        {transfer.busy ? "Updating Project inclusions…" : transfer.announcement}
      </span>
    </section>
  );
}
