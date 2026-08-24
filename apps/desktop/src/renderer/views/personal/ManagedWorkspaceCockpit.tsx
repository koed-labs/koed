import type {
  ManagedConversationDiff,
  ManagedConversationFileOperation,
  ManagedConversationFileOperationResult,
  ManagedConversationFileRevision,
  ManagedDevelopmentPreviewRecord,
  ManagedTerminalRecord,
  ManagedTerminalServerFrame,
  ManagedTerminalShellProfile,
  SourceControlCheck,
  SourceControlBranch,
  SourceControlComment,
  SourceControlRemote,
  SourceControlReviewRequest
} from "@koed/shared";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronLeft,
  FileCode2,
  FileDiff,
  Files,
  Folder,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Monitor,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  SquareTerminal,
  Undo2,
  Upload,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";

import type { ManagedWorkspaceDesktopApi } from "../../../ipc/managed-workspace-protocol.js";

type WorkspaceIdentity = {
  executionId: string;
  executionGeneration: number;
};

type PendingFileOperation = {
  commandId: string;
  intent: "browse" | "read" | "search" | "mention";
};

const commandRequest = (executionId: string) => ({
  requestId: crypto.randomUUID(),
  executionId
});

const utf8Base64 = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64Utf8 = (value: string): string => {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const pathParent = (path: string): string => {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
};

const pathName = (path: string): string => path.split("/").at(-1) ?? path;

export function ManagedWorkspaceCockpit({
  api,
  identity,
  revision,
  onAttachFile,
  onAttachTerminal
}: {
  api: ManagedWorkspaceDesktopApi;
  identity: WorkspaceIdentity;
  revision: number;
  onAttachFile: (attachment: { commandId: string; label: string }) => void;
  onAttachTerminal: (attachment: {
    contextReference: string;
    label: string;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<
    "changes" | "files" | "terminal" | "preview" | "source"
  >("changes");
  const [error, setError] = useState("");
  const [diff, setDiff] = useState<ManagedConversationDiff | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [selectedDiffPath, setSelectedDiffPath] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileRevision, setFileRevision] =
    useState<ManagedConversationFileRevision | null>(null);
  const [browseResult, setBrowseResult] = useState<Extract<
    ManagedConversationFileOperationResult,
    { kind: "browse" }
  > | null>(null);
  const [readResult, setReadResult] = useState<Extract<
    ManagedConversationFileOperationResult,
    { kind: "read" }
  > | null>(null);
  const [searchResult, setSearchResult] = useState<Extract<
    ManagedConversationFileOperationResult,
    { kind: "search" }
  > | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingFile, setPendingFile] = useState<PendingFileOperation | null>(
    null
  );
  const [terminals, setTerminals] = useState<ManagedTerminalRecord[]>([]);
  const [terminalProfiles, setTerminalProfiles] = useState<
    ManagedTerminalShellProfile[]
  >([]);
  const [activeTerminal, setActiveTerminal] =
    useState<ManagedTerminalRecord | null>(null);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalMessage, setTerminalMessage] = useState("");
  const [terminalOutputRange, setTerminalOutputRange] = useState({
    earliest: 0,
    latest: 0
  });
  const [previews, setPreviews] = useState<ManagedDevelopmentPreviewRecord[]>(
    []
  );
  const [activePreview, setActivePreview] =
    useState<ManagedDevelopmentPreviewRecord | null>(null);
  const [previewState, setPreviewState] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [previewPort, setPreviewPort] = useState("");
  const [previewViewport, setPreviewViewport] = useState<"desktop" | "mobile">(
    "desktop"
  );
  const [sourceRemotes, setSourceRemotes] = useState<SourceControlRemote[]>([]);
  const [sourceRemote, setSourceRemote] = useState<SourceControlRemote | null>(
    null
  );
  const [sourceHead, setSourceHead] = useState("");
  const [sourceDefaultBranch, setSourceDefaultBranch] = useState("");
  const [sourceDefaultObjectId, setSourceDefaultObjectId] = useState("");
  const [sourceCurrentBranch, setSourceCurrentBranch] = useState("");
  const [sourceBranches, setSourceBranches] = useState<SourceControlBranch[]>(
    []
  );
  const [reviewRequests, setReviewRequests] = useState<
    SourceControlReviewRequest[]
  >([]);
  const [activeReview, setActiveReview] =
    useState<SourceControlReviewRequest | null>(null);
  const [sourceChecks, setSourceChecks] = useState<SourceControlCheck[]>([]);
  const [sourceComments, setSourceComments] = useState<SourceControlComment[]>(
    []
  );
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceComment, setSourceComment] = useState("");
  const [sourceReviewTitle, setSourceReviewTitle] = useState("");
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const previewElementRef = useRef<HTMLDivElement | null>(null);
  const previewSurfaceIdRef = useRef(crypto.randomUUID());
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionIdRef = useRef(crypto.randomUUID());
  const inputEpochRef = useRef("");
  const inputSequenceRef = useRef(0);
  const frameSequenceRef = useRef(0);
  const outputRangeRef = useRef({ earliest: 0, latest: 0 });
  const settlingFileCommandRef = useRef<string | null>(null);

  const loadPreviews = useCallback(async () => {
    try {
      const result = await api.command({
        ...commandRequest(identity.executionId),
        operation: "preview_list"
      });
      if (result.operation !== "preview_list") return;
      setPreviews(result.previews);
      setActivePreview((current) => {
        const retained = result.previews.find(
          (preview) =>
            preview.id === current?.id && preview.state === "available"
        );
        return (
          retained ??
          result.previews.find((preview) => preview.state === "available") ??
          null
        );
      });
    } catch {
      setError("Koed could not load development previews.");
    }
  }, [api, identity.executionId]);

  const sourceControl = useCallback(
    async (sourceControlOperation: Record<string, unknown>) => {
      const result = await api.command({
        ...commandRequest(identity.executionId),
        operation: "source_control",
        sourceControlOperation: {
          contractVersion: 1,
          executionId: identity.executionId,
          executionGeneration: identity.executionGeneration,
          ...sourceControlOperation
        } as never
      });
      if (result.operation !== "source_control") {
        throw new Error("Unexpected source-control response.");
      }
      return result.result;
    },
    [api, identity.executionGeneration, identity.executionId]
  );

  const loadSourceControl = useCallback(async () => {
    setSourceBusy(true);
    try {
      const result = await sourceControl({ kind: "remotes" });
      if (result.kind !== "remotes") return;
      setSourceRemotes(result.remotes);
      setSourceHead(result.headObjectId);
      const selected =
        result.remotes.find(
          (remote) =>
            remote.remoteIdentityHash === sourceRemote?.remoteIdentityHash
        ) ??
        result.remotes.find(
          (remote) => remote.connectionState === "connected"
        ) ??
        result.remotes[0] ??
        null;
      setSourceRemote(selected);
      if (!selected || selected.connectionState !== "connected") {
        setReviewRequests([]);
        setActiveReview(null);
        setSourceDefaultBranch("");
        setSourceDefaultObjectId("");
        setSourceCurrentBranch("");
        setSourceBranches([]);
        return;
      }
      const [inspection, reviews, branches] = await Promise.all([
        selected.capabilities.includes("repository_read")
          ? sourceControl({
              kind: "inspect",
              remoteIdentityHash: selected.remoteIdentityHash
            })
          : null,
        selected.capabilities.includes("review_request_read")
          ? sourceControl({
              kind: "review_requests",
              remoteIdentityHash: selected.remoteIdentityHash,
              state: "open",
              cursor: null
            })
          : null,
        selected.capabilities.includes("branch_read")
          ? sourceControl({
              kind: "branches",
              remoteIdentityHash: selected.remoteIdentityHash,
              cursor: null
            })
          : null
      ]);
      if (inspection?.kind === "inspect") {
        setSourceDefaultBranch(inspection.defaultBranch);
        setSourceDefaultObjectId(inspection.defaultBranchObjectId);
        setSourceCurrentBranch(inspection.currentBranch ?? "");
      }
      setSourceBranches(branches?.kind === "branches" ? branches.branches : []);
      const nextReviews =
        reviews?.kind === "review_requests" ? reviews.reviewRequests : [];
      setReviewRequests(nextReviews);
      setActiveReview(
        (current) =>
          nextReviews.find((item) => item.id === current?.id) ??
          nextReviews[0] ??
          null
      );
    } catch {
      setError("Koed could not load source control.");
    } finally {
      setSourceBusy(false);
    }
  }, [sourceControl, sourceRemote?.remoteIdentityHash]);

  const loadReviewDetail = useCallback(
    async (review: SourceControlReviewRequest) => {
      if (!sourceRemote) return;
      setSourceBusy(true);
      try {
        const [checks, comments] = await Promise.all([
          sourceRemote.capabilities.includes("checks_read")
            ? sourceControl({
                kind: "checks",
                remoteIdentityHash: sourceRemote.remoteIdentityHash,
                objectId: review.headObjectId
              })
            : null,
          sourceRemote.capabilities.includes("comments_read")
            ? sourceControl({
                kind: "comments",
                remoteIdentityHash: sourceRemote.remoteIdentityHash,
                number: review.number,
                cursor: null
              })
            : null
        ]);
        setSourceChecks(checks?.kind === "checks" ? checks.checks : []);
        setSourceComments(
          comments?.kind === "comments" ? comments.comments : []
        );
      } catch {
        setError("Koed could not load this review request.");
      } finally {
        setSourceBusy(false);
      }
    },
    [sourceControl, sourceRemote]
  );

  const updateOutputRange = useCallback(
    (next: { earliest: number; latest: number }) => {
      outputRangeRef.current = next;
      setTerminalOutputRange(next);
    },
    []
  );

  const selectedDiff = useMemo(
    () =>
      diff?.diff.files.find((file) => file.path === selectedDiffPath) ?? null,
    [diff, selectedDiffPath]
  );

  const restoreBaseline = useCallback(async () => {
    if (!diff || restoreBusy) return;
    if (
      !window.confirm(
        "Restore the Project files to their state before these changes? Koed will keep a recovery checkpoint."
      )
    ) {
      return;
    }
    setRestoreBusy(true);
    setError("");
    try {
      await api.command({
        ...commandRequest(identity.executionId),
        operation: "checkpoint_restore",
        executionGeneration: identity.executionGeneration,
        checkpointId: diff.fromCheckpointId,
        idempotencyKey: `checkpoint-restore:${crypto.randomUUID()}`
      });
    } catch {
      setError("Koed could not queue Restore for this Project.");
    } finally {
      setRestoreBusy(false);
    }
  }, [
    api,
    diff,
    identity.executionGeneration,
    identity.executionId,
    restoreBusy
  ]);

  useEffect(() => {
    if (!open || tab !== "changes") return;
    let active = true;
    setError("");
    void api
      .command({
        ...commandRequest(identity.executionId),
        operation: "diff_read",
        scope: "full"
      })
      .then((result) => {
        if (!active || result.operation !== "diff_read") return;
        setDiff(result.value);
        setSelectedDiffPath((current) =>
          result.value.diff.files.some((file) => file.path === current)
            ? current
            : (result.value.diff.files[0]?.path ?? "")
        );
      })
      .catch(() => {
        if (active) {
          setDiff(null);
          setError("No exact change snapshot is available yet.");
        }
      });
    return () => {
      active = false;
    };
  }, [api, identity.executionId, open, revision, tab]);

  const settleFileOperation = useCallback(
    async (pending: PendingFileOperation) => {
      if (settlingFileCommandRef.current === pending.commandId) return;
      settlingFileCommandRef.current = pending.commandId;
      try {
        const response = await api.command({
          ...commandRequest(identity.executionId),
          operation: "file_result",
          commandId: pending.commandId
        });
        if (
          response.operation !== "file_result" ||
          response.command.state !== "completed" ||
          !response.result
        ) {
          if (
            response.operation === "file_result" &&
            ["failed", "indeterminate", "cancelled"].includes(
              response.command.state
            )
          ) {
            setPendingFile(null);
            setError("The file operation could not be completed.");
          }
          return;
        }
        setFileRevision(response.result.revision);
        if (response.result.kind === "browse") {
          setBrowseResult(response.result);
          setReadResult(null);
        } else if (response.result.kind === "read") {
          setReadResult(response.result);
        } else if (response.result.kind === "search") {
          setSearchResult(response.result);
        } else {
          onAttachFile({
            commandId: pending.commandId,
            label: response.result.path
          });
        }
        setPendingFile(null);
      } finally {
        if (settlingFileCommandRef.current === pending.commandId) {
          settlingFileCommandRef.current = null;
        }
      }
    },
    [api, identity.executionId, onAttachFile]
  );

  const startFileOperation = useCallback(
    async (
      fileOperation: ManagedConversationFileOperation,
      intent: PendingFileOperation["intent"]
    ) => {
      setError("");
      try {
        const response = await api.command({
          ...commandRequest(identity.executionId),
          operation: "file_start",
          executionGeneration: identity.executionGeneration,
          idempotencyKey: `desktop-file:${crypto.randomUUID()}`,
          fileOperation
        });
        if (response.operation !== "file_start") return;
        const pending = { commandId: response.command.id, intent };
        setPendingFile(pending);
        await settleFileOperation(pending);
      } catch {
        setPendingFile(null);
        setError("The file operation could not be completed.");
      }
    },
    [api, identity, settleFileOperation]
  );

  useEffect(() => {
    if (!pendingFile) return;
    void settleFileOperation(pendingFile).catch(() => {
      setPendingFile(null);
      setError("The file operation could not be completed.");
    });
  }, [pendingFile, revision, settleFileOperation]);

  useEffect(() => {
    if (!open || tab !== "files" || browseResult || pendingFile) return;
    void startFileOperation(
      {
        kind: "browse",
        path: filePath,
        revision: fileRevision,
        offset: 0,
        limit: 200
      },
      "browse"
    ).catch(() => setError("Files are unavailable for this Conversation."));
  }, [
    browseResult,
    filePath,
    fileRevision,
    open,
    pendingFile,
    startFileOperation,
    tab
  ]);

  const loadTerminals = useCallback(() => {
    let active = true;
    void Promise.all([
      api.command({
        ...commandRequest(identity.executionId),
        operation: "terminal_list"
      }),
      api.command({
        ...commandRequest(identity.executionId),
        operation: "terminal_profiles"
      })
    ])
      .then(([terminalResult, profileResult]) => {
        if (
          !active ||
          terminalResult.operation !== "terminal_list" ||
          profileResult.operation !== "terminal_profiles"
        )
          return;
        setTerminals(terminalResult.terminals);
        setTerminalProfiles(profileResult.profiles);
        setActiveTerminal((current) => {
          const next =
            terminalResult.terminals.find(
              (terminal) => terminal.id === current?.id
            ) ??
            terminalResult.terminals.find((terminal) =>
              ["running", "detached"].includes(terminal.state)
            ) ??
            null;
          return current &&
            next &&
            current.id === next.id &&
            current.state === next.state &&
            current.lifecycleGeneration === next.lifecycleGeneration
            ? current
            : next;
        });
      })
      .catch(() => {
        if (active) setError("Terminal access is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [api, identity.executionId]);

  useEffect(() => {
    if (!open || tab !== "terminal") return;
    return loadTerminals();
  }, [loadTerminals, open, tab]);

  useEffect(() => {
    if (!open || tab !== "preview") return;
    void loadPreviews();
    return loadTerminals();
  }, [loadPreviews, loadTerminals, open, tab]);

  useEffect(() => {
    if (!open || tab !== "source") return;
    void loadSourceControl();
  }, [loadSourceControl, open, revision, tab]);

  useEffect(() => {
    if (!open || tab !== "source" || !activeReview) {
      setSourceChecks([]);
      setSourceComments([]);
      return;
    }
    void loadReviewDetail(activeReview);
  }, [activeReview, loadReviewDetail, open, tab]);

  useLayoutEffect(() => {
    const element = previewElementRef.current;
    if (
      !open ||
      tab !== "preview" ||
      !activePreview ||
      activePreview.state !== "available" ||
      !element
    ) {
      return;
    }
    const surfaceId = previewSurfaceIdRef.current;
    let attached = false;
    let cancelled = false;
    let frame = 0;
    const bounds = () => {
      const rect = element.getBoundingClientRect();
      const width =
        previewViewport === "mobile"
          ? Math.min(390, Math.max(1, Math.floor(rect.width)))
          : Math.max(1, Math.floor(rect.width));
      return {
        x: Math.max(0, Math.round(rect.x + (rect.width - width) / 2)),
        y: Math.max(0, Math.round(rect.y)),
        width,
        height: Math.max(1, Math.floor(rect.height))
      };
    };
    const updateBounds = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!attached) return;
        void api
          .command({
            ...commandRequest(identity.executionId),
            operation: "preview_bounds",
            surfaceId,
            bounds: bounds()
          })
          .catch(() => setPreviewState("failed"));
      });
    };
    setPreviewState("loading");
    void api
      .command({
        ...commandRequest(identity.executionId),
        operation: "preview_attach",
        surfaceId,
        previewId: activePreview.id,
        lifecycleGeneration: activePreview.lifecycleGeneration,
        bounds: bounds()
      })
      .then(() => {
        if (cancelled) {
          void api
            .command({
              ...commandRequest(identity.executionId),
              operation: "preview_detach",
              surfaceId
            })
            .catch(() => undefined);
          return;
        }
        attached = true;
      })
      .catch(() => setPreviewState("failed"));
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateBounds);
    observer?.observe(element);
    window.addEventListener("resize", updateBounds);
    window.addEventListener("scroll", updateBounds, true);
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener("resize", updateBounds);
      window.removeEventListener("scroll", updateBounds, true);
      cancelAnimationFrame(frame);
      void api
        .command({
          ...commandRequest(identity.executionId),
          operation: "preview_detach",
          surfaceId
        })
        .catch(() => undefined);
    };
  }, [activePreview, api, identity.executionId, open, previewViewport, tab]);

  useLayoutEffect(() => {
    const element = terminalElementRef.current;
    if (
      !open ||
      tab !== "terminal" ||
      !activeTerminal ||
      !["running", "detached"].includes(activeTerminal.state) ||
      !element
    )
      return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      rows: activeTerminal.rows,
      cols: activeTerminal.columns,
      scrollback: 5_000,
      theme: { background: "#111214", foreground: "#e7e7e7" }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const connectionId = connectionIdRef.current;
    const sendFrame = (
      frame: Parameters<ManagedWorkspaceDesktopApi["command"]>[0]
    ) =>
      api
        .command(frame)
        .catch(() => setTerminalMessage("Terminal disconnected."));
    const dataDisposable = terminal.onData((data) => {
      if (!inputEpochRef.current) return;
      inputSequenceRef.current += 1;
      void sendFrame({
        ...commandRequest(identity.executionId),
        operation: "terminal_send",
        connectionId,
        frame: {
          protocolVersion: 1,
          terminalId: activeTerminal.id,
          lifecycleGeneration: activeTerminal.lifecycleGeneration,
          type: "terminal.input",
          inputEpoch: inputEpochRef.current,
          sequence: inputSequenceRef.current,
          dataBase64: utf8Base64(data)
        }
      });
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      frameSequenceRef.current += 1;
      void sendFrame({
        ...commandRequest(identity.executionId),
        operation: "terminal_send",
        connectionId,
        frame: {
          protocolVersion: 1,
          terminalId: activeTerminal.id,
          lifecycleGeneration: activeTerminal.lifecycleGeneration,
          type: "terminal.resize",
          sequence: frameSequenceRef.current,
          columns: cols,
          rows
        }
      });
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            try {
              fit.fit();
            } catch {
              // A closing Electron view can detach before xterm measures it.
            }
          });
    resizeObserver?.observe(element);
    void api
      .command({
        ...commandRequest(identity.executionId),
        operation: "terminal_attach",
        connectionId,
        terminalId: activeTerminal.id,
        lifecycleGeneration: activeTerminal.lifecycleGeneration,
        afterOutputSequence: outputRangeRef.current.latest
      })
      .catch(() => setTerminalMessage("Terminal disconnected."));
    return () => {
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      void api
        .command({
          ...commandRequest(identity.executionId),
          operation: "terminal_detach",
          connectionId
        })
        .catch(() => undefined);
    };
  }, [activeTerminal, api, identity.executionId, open, tab]);

  useEffect(
    () =>
      api.subscribe((event) => {
        if (event.kind === "preview") {
          if (event.surfaceId !== previewSurfaceIdRef.current) return;
          setPreviewState(event.state === "closed" ? "idle" : event.state);
          return;
        }
        if (event.connectionId !== connectionIdRef.current) return;
        const frame: ManagedTerminalServerFrame = event.frame;
        if (frame.type === "terminal.ready") {
          inputEpochRef.current = frame.inputEpoch;
          inputSequenceRef.current = 0;
          frameSequenceRef.current = 0;
          updateOutputRange({
            earliest: frame.earliestOutputSequence,
            latest: frame.latestOutputSequence
          });
          setTerminalMessage("");
        } else if (frame.type === "terminal.output") {
          updateOutputRange({
            earliest: outputRangeRef.current.earliest,
            latest: Math.max(outputRangeRef.current.latest, frame.sequence)
          });
          terminalRef.current?.write(base64Utf8(frame.dataBase64));
        } else if (frame.type === "terminal.replay_gap") {
          updateOutputRange({
            earliest: frame.earliestOutputSequence,
            latest: outputRangeRef.current.latest
          });
          terminalRef.current?.writeln(
            "\r\n[Earlier terminal output is unavailable]\r\n"
          );
        } else if (frame.type === "terminal.context.captured") {
          onAttachTerminal({
            contextReference: frame.contextReference,
            label: "Terminal output"
          });
          setTerminalMessage("Terminal output attached to the next prompt.");
        } else if (frame.type === "terminal.exit") {
          setTerminalMessage("Terminal exited.");
        } else if (frame.type === "terminal.error") {
          setTerminalMessage("Terminal disconnected.");
        }
      }),
    [api, onAttachTerminal, updateOutputRange]
  );

  const createTerminal = async () => {
    setTerminalBusy(true);
    setError("");
    try {
      const result = await api.command({
        ...commandRequest(identity.executionId),
        operation: "terminal_create",
        input: {
          executionGeneration: identity.executionGeneration,
          idempotencyKey: `desktop-terminal:${crypto.randomUUID()}`,
          shellProfileId: "system_default",
          columns: 100,
          rows: 28
        }
      });
      if (result.operation === "terminal_create") {
        connectionIdRef.current = crypto.randomUUID();
        updateOutputRange({ earliest: 0, latest: 0 });
        setTerminals((current) => [...current, result.terminal]);
        setActiveTerminal(result.terminal);
      }
    } catch {
      setError("Koed could not create a terminal for this Conversation.");
    } finally {
      setTerminalBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        aria-label="Open coding workspace"
        className="personal-cockpit-open"
        onClick={() => setOpen(true)}
        title="Open coding workspace"
        type="button"
      >
        <FileCode2 aria-hidden="true" />
      </button>
    );
  }

  return (
    <aside className="personal-cockpit" aria-label="Coding workspace">
      <div className="personal-cockpit-toolbar">
        <div role="tablist" aria-label="Coding workspace views">
          <button
            aria-label="Changes"
            aria-selected={tab === "changes"}
            onClick={() => setTab("changes")}
            role="tab"
            title="Changes"
            type="button"
          >
            <FileDiff aria-hidden="true" />
          </button>
          <button
            aria-label="Files"
            aria-selected={tab === "files"}
            onClick={() => setTab("files")}
            role="tab"
            title="Files"
            type="button"
          >
            <Files aria-hidden="true" />
          </button>
          <button
            aria-label="Source control"
            aria-selected={tab === "source"}
            onClick={() => setTab("source")}
            role="tab"
            title="Source control"
            type="button"
          >
            <GitPullRequest aria-hidden="true" />
          </button>
          <button
            aria-label="Terminal"
            aria-selected={tab === "terminal"}
            onClick={() => setTab("terminal")}
            role="tab"
            title="Terminal"
            type="button"
          >
            <SquareTerminal aria-hidden="true" />
          </button>
          <button
            aria-label="Preview"
            aria-selected={tab === "preview"}
            onClick={() => setTab("preview")}
            role="tab"
            title="Preview"
            type="button"
          >
            <Monitor aria-hidden="true" />
          </button>
        </div>
        <button
          aria-label="Close coding workspace"
          onClick={() => setOpen(false)}
          type="button"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      {tab === "changes" ? (
        <div className="personal-cockpit-split">
          <nav aria-label="Changed files">
            {diff?.diff.files.length ? (
              <button
                disabled={restoreBusy}
                onClick={() => void restoreBaseline()}
                title="Restore files to the baseline checkpoint"
                type="button"
              >
                {restoreBusy ? (
                  <LoaderCircle
                    aria-hidden="true"
                    className="personal-cockpit-spin"
                  />
                ) : (
                  <Undo2 aria-hidden="true" />
                )}
                Restore
              </button>
            ) : null}
            {diff?.diff.files.length ? (
              diff.diff.files.map((file) => (
                <button
                  aria-current={
                    file.path === selectedDiffPath ? "true" : undefined
                  }
                  key={file.path}
                  onClick={() => setSelectedDiffPath(file.path)}
                  type="button"
                >
                  <span>{file.status.slice(0, 1).toUpperCase()}</span>
                  {file.path}
                </button>
              ))
            ) : (
              <p>No changed files.</p>
            )}
          </nav>
          <div className="personal-cockpit-code">
            {selectedDiff ? (
              <>
                <header>{selectedDiff.path}</header>
                <pre>
                  <code>
                    {selectedDiff.binary
                      ? "Binary file changed"
                      : (selectedDiff.patch ?? "Patch unavailable")}
                  </code>
                </pre>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "files" ? (
        <div className="personal-files-view">
          <form
            className="personal-file-search"
            onSubmit={(event) => {
              event.preventDefault();
              if (!searchQuery.trim() || pendingFile) return;
              void startFileOperation(
                {
                  kind: "search",
                  path: filePath,
                  revision: fileRevision,
                  query: searchQuery.trim(),
                  caseSensitive: false,
                  offset: 0,
                  limit: 100
                },
                "search"
              );
            }}
          >
            <Search aria-hidden="true" />
            <input
              aria-label="Search workspace files"
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Search files"
              value={searchQuery}
            />
          </form>
          <div className="personal-file-location">
            <button
              aria-label="Open parent directory"
              disabled={!filePath || Boolean(pendingFile)}
              onClick={() => {
                const next = pathParent(filePath);
                setFilePath(next);
                setBrowseResult(null);
                setReadResult(null);
              }}
              type="button"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span>/{filePath}</span>
          </div>
          {pendingFile ? (
            <LoaderCircle
              className="personal-cockpit-spin"
              aria-label="Loading files"
            />
          ) : null}
          {searchResult ? (
            <div className="personal-file-results">
              {searchResult.matches.map((match) => (
                <button
                  key={`${match.path}:${match.line}:${match.column}`}
                  onClick={() => {
                    setSearchResult(null);
                    void startFileOperation(
                      {
                        kind: "read",
                        path: match.path,
                        revision: fileRevision,
                        offset: 0,
                        limit: 1024 * 1024
                      },
                      "read"
                    );
                  }}
                  type="button"
                >
                  <strong>
                    {match.path}:{match.line}
                  </strong>
                  <span>{match.preview}</span>
                </button>
              ))}
            </div>
          ) : readResult ? (
            <div className="personal-file-reader">
              <header>
                <span>{readResult.path}</span>
                <button
                  disabled={Boolean(pendingFile)}
                  onClick={() =>
                    void startFileOperation(
                      {
                        kind: "mention",
                        path: readResult.path,
                        revision: readResult.revision
                      },
                      "mention"
                    )
                  }
                  type="button"
                >
                  <Paperclip aria-hidden="true" /> Attach
                </button>
              </header>
              <pre>
                <code>{readResult.content}</code>
              </pre>
            </div>
          ) : (
            <div className="personal-file-list">
              {browseResult?.entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => {
                    if (entry.entryKind === "directory") {
                      setFilePath(entry.path);
                      setBrowseResult(null);
                    } else {
                      void startFileOperation(
                        {
                          kind: "read",
                          path: entry.path,
                          revision: fileRevision,
                          offset: 0,
                          limit: 1024 * 1024
                        },
                        "read"
                      );
                    }
                  }}
                  type="button"
                >
                  {entry.entryKind === "directory" ? (
                    <Folder aria-hidden="true" />
                  ) : (
                    <FileCode2 aria-hidden="true" />
                  )}
                  <span>{pathName(entry.path)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === "terminal" ? (
        <div className="personal-terminal-view">
          <div className="personal-terminal-toolbar">
            <select
              aria-label="Active terminal"
              onChange={(event) => {
                const selected =
                  terminals.find(
                    (terminal) => terminal.id === event.currentTarget.value
                  ) ?? null;
                connectionIdRef.current = crypto.randomUUID();
                updateOutputRange({ earliest: 0, latest: 0 });
                setActiveTerminal(selected);
              }}
              value={activeTerminal?.id ?? ""}
            >
              <option value="">No terminal</option>
              {terminals.map((terminal, index) => (
                <option key={terminal.id} value={terminal.id}>
                  Terminal {index + 1} · {terminal.state}
                </option>
              ))}
            </select>
            <button
              aria-label="New terminal"
              disabled={
                terminalBusy ||
                !terminalProfiles.some((profile) => profile.available)
              }
              onClick={() => void createTerminal()}
              title="New terminal"
              type="button"
            >
              <Plus aria-hidden="true" />
            </button>
            <button
              disabled={
                !activeTerminal ||
                terminalOutputRange.latest === 0 ||
                terminalOutputRange.latest < terminalOutputRange.earliest
              }
              onClick={() => {
                if (!activeTerminal) return;
                void api.command({
                  ...commandRequest(identity.executionId),
                  operation: "terminal_send",
                  connectionId: connectionIdRef.current,
                  frame: {
                    protocolVersion: 1,
                    terminalId: activeTerminal.id,
                    lifecycleGeneration: activeTerminal.lifecycleGeneration,
                    type: "terminal.context.capture",
                    requestId: crypto.randomUUID(),
                    fromOutputSequence: outputRangeRef.current.earliest,
                    toOutputSequence: outputRangeRef.current.latest
                  }
                });
              }}
              type="button"
            >
              <Paperclip aria-hidden="true" /> Attach output
            </button>
            <button
              aria-label="Stop terminal"
              disabled={!activeTerminal || terminalBusy}
              onClick={() => {
                if (!activeTerminal) return;
                setTerminalBusy(true);
                void api
                  .command({
                    ...commandRequest(identity.executionId),
                    operation: "terminal_stop",
                    terminalId: activeTerminal.id
                  })
                  .then((result) => {
                    if (result.operation !== "terminal_stop") return;
                    setTerminals((current) =>
                      current.map((terminal) =>
                        terminal.id === result.terminal.id
                          ? result.terminal
                          : terminal
                      )
                    );
                    setActiveTerminal(result.terminal);
                  })
                  .catch(() => setError("Koed could not stop this terminal."))
                  .finally(() => setTerminalBusy(false));
              }}
              title="Stop terminal"
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="personal-terminal-host" ref={terminalElementRef} />
          {terminalMessage ? <p role="status">{terminalMessage}</p> : null}
        </div>
      ) : null}

      {tab === "preview" ? (
        <div className="personal-preview-view">
          <div className="personal-preview-toolbar">
            <select
              aria-label="Development preview"
              onChange={(event) => {
                const selected =
                  previews.find(
                    (preview) => preview.id === event.currentTarget.value
                  ) ?? null;
                previewSurfaceIdRef.current = crypto.randomUUID();
                setPreviewState(selected ? "loading" : "idle");
                setActivePreview(selected);
              }}
              value={activePreview?.id ?? ""}
            >
              <option value="">No preview</option>
              {previews
                .filter((preview) => preview.state === "available")
                .map((preview, index) => (
                  <option key={preview.id} value={preview.id}>
                    Preview {index + 1}
                  </option>
                ))}
            </select>
            <div
              aria-label="Preview viewport"
              className="personal-preview-viewport-toggle"
              role="group"
            >
              <button
                aria-pressed={previewViewport === "desktop"}
                onClick={() => setPreviewViewport("desktop")}
                title="Desktop viewport"
                type="button"
              >
                <Monitor aria-hidden="true" />
              </button>
              <button
                aria-pressed={previewViewport === "mobile"}
                onClick={() => setPreviewViewport("mobile")}
                title="Mobile viewport"
                type="button"
              >
                <Smartphone aria-hidden="true" />
              </button>
            </div>
            <button
              aria-label="Reload preview"
              disabled={!activePreview}
              onClick={() => {
                setPreviewState("loading");
                void api
                  .command({
                    ...commandRequest(identity.executionId),
                    operation: "preview_reload",
                    surfaceId: previewSurfaceIdRef.current
                  })
                  .catch(() => setPreviewState("failed"));
              }}
              title="Reload preview"
              type="button"
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <button
              aria-label="Refresh preview list"
              onClick={() => void loadPreviews()}
              title="Refresh preview list"
              type="button"
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <form
              className="personal-preview-port"
              onSubmit={(event) => {
                event.preventDefault();
                const terminal = ["running", "detached"].includes(
                  activeTerminal?.state ?? ""
                )
                  ? activeTerminal
                  : terminals.find((item) =>
                      ["running", "detached"].includes(item.state)
                    );
                const port = Number(previewPort);
                if (!terminal || !Number.isInteger(port)) return;
                setPreviewState("loading");
                void api
                  .command({
                    ...commandRequest(identity.executionId),
                    operation: "preview_nominate",
                    candidate: {
                      executionGeneration: identity.executionGeneration,
                      terminalId: terminal.id,
                      scheme: "http",
                      port
                    }
                  })
                  .then((result) => {
                    if (result.operation !== "preview_nominate") return;
                    setPreviews((current) => [
                      result.preview,
                      ...current.filter(
                        (preview) => preview.id !== result.preview.id
                      )
                    ]);
                    setActivePreview(result.preview);
                    setPreviewPort("");
                  })
                  .catch(() => {
                    setPreviewState("failed");
                    setError(
                      "That port is not owned by this Conversation's terminal."
                    );
                  });
              }}
            >
              <input
                aria-label="Development server port"
                inputMode="numeric"
                max="65535"
                min="1"
                onChange={(event) => setPreviewPort(event.currentTarget.value)}
                placeholder="Port"
                type="number"
                value={previewPort}
              />
              <button
                disabled={
                  !previewPort ||
                  !terminals.some((terminal) =>
                    ["running", "detached"].includes(terminal.state)
                  )
                }
                type="submit"
              >
                Open
              </button>
            </form>
          </div>
          <div
            className={`personal-preview-host personal-preview-host-${previewViewport}`}
            ref={previewElementRef}
          >
            {!activePreview ? (
              <p>Start a development server in Terminal.</p>
            ) : null}
          </div>
          {activePreview && previewState !== "ready" ? (
            <p className="personal-preview-state" role="status">
              {previewState === "failed"
                ? "Preview unavailable"
                : "Loading preview"}
            </p>
          ) : null}
        </div>
      ) : null}
      {tab === "source" ? (
        <div className="personal-source-view">
          <div className="personal-source-toolbar">
            <select
              aria-label="Source-control remote"
              onChange={(event) => {
                const selected =
                  sourceRemotes.find(
                    (remote) =>
                      remote.remoteIdentityHash === event.currentTarget.value
                  ) ?? null;
                setSourceRemote(selected);
                setReviewRequests([]);
                setActiveReview(null);
              }}
              value={sourceRemote?.remoteIdentityHash ?? ""}
            >
              <option value="">No remote</option>
              {sourceRemotes.map((remote) => (
                <option
                  key={remote.remoteIdentityHash}
                  value={remote.remoteIdentityHash}
                >
                  {remote.remoteName} · {remote.provider.replace("_", " ")}
                </option>
              ))}
            </select>
            <span title={sourceHead}>{sourceHead.slice(0, 8)}</span>
            <button
              aria-label="Fetch remote"
              disabled={
                sourceBusy ||
                sourceRemote?.connectionState !== "connected" ||
                !sourceRemote.credentialGeneration ||
                !sourceRemote.capabilities.includes("fetch")
              }
              onClick={() => {
                if (!sourceRemote?.credentialGeneration) return;
                setSourceBusy(true);
                void sourceControl({
                  kind: "fetch",
                  remoteIdentityHash: sourceRemote.remoteIdentityHash,
                  remoteName: sourceRemote.remoteName,
                  expectedHeadObjectId: sourceHead,
                  credentialGeneration: sourceRemote.credentialGeneration,
                  idempotencyKey: `desktop-source-fetch:${crypto.randomUUID()}`
                })
                  .then(() => loadSourceControl())
                  .catch(() =>
                    setError("Koed could not fetch the selected remote.")
                  )
                  .finally(() => setSourceBusy(false));
              }}
              title="Fetch remote"
              type="button"
            >
              <RefreshCw aria-hidden="true" />
            </button>
            <button
              aria-label="Fast-forward current branch"
              disabled={
                sourceBusy ||
                !sourceRemote?.credentialGeneration ||
                !sourceRemote.capabilities.includes("fetch") ||
                !sourceDefaultBranch ||
                !sourceDefaultObjectId ||
                sourceDefaultObjectId === sourceHead
              }
              onClick={() => {
                if (
                  !sourceRemote?.credentialGeneration ||
                  !sourceDefaultBranch ||
                  !sourceDefaultObjectId
                )
                  return;
                setSourceBusy(true);
                void sourceControl({
                  kind: "fast_forward",
                  remoteIdentityHash: sourceRemote.remoteIdentityHash,
                  remoteName: sourceRemote.remoteName,
                  remoteBranch: sourceDefaultBranch,
                  expectedRemoteObjectId: sourceDefaultObjectId,
                  expectedHeadObjectId: sourceHead,
                  credentialGeneration: sourceRemote.credentialGeneration,
                  idempotencyKey: `desktop-source-fast-forward:${crypto.randomUUID()}`
                })
                  .then(() => loadSourceControl())
                  .catch(() =>
                    setError("Koed could not fast-forward this branch.")
                  )
                  .finally(() => setSourceBusy(false));
              }}
              title="Fast-forward from default branch"
              type="button"
            >
              <GitBranch aria-hidden="true" />
            </button>
            <button
              aria-label="Push current branch"
              disabled={
                sourceBusy ||
                !sourceRemote?.credentialGeneration ||
                !sourceRemote.capabilities.includes("push") ||
                !sourceCurrentBranch
              }
              onClick={() => {
                if (!sourceRemote?.credentialGeneration || !sourceCurrentBranch)
                  return;
                const currentRemoteBranch = sourceBranches.find(
                  (branch) => branch.name === sourceCurrentBranch
                );
                setSourceBusy(true);
                void sourceControl({
                  kind: "push",
                  remoteIdentityHash: sourceRemote.remoteIdentityHash,
                  remoteName: sourceRemote.remoteName,
                  targetBranch: sourceCurrentBranch,
                  expectedRemoteObjectId: currentRemoteBranch?.objectId ?? null,
                  expectedHeadObjectId: sourceHead,
                  credentialGeneration: sourceRemote.credentialGeneration,
                  idempotencyKey: `desktop-source-push:${crypto.randomUUID()}`
                })
                  .then(() => loadSourceControl())
                  .catch(() =>
                    setError("Koed could not push the current branch.")
                  )
                  .finally(() => setSourceBusy(false));
              }}
              title="Push current branch"
              type="button"
            >
              <Upload aria-hidden="true" />
            </button>
          </div>
          {sourceRemote?.connectionState !== "connected" ? (
            <p className="personal-source-empty">
              Connect an account for this repository host to review remote work.
            </p>
          ) : (
            <>
              {sourceRemote.capabilities.includes("review_request_create") &&
              sourceCurrentBranch &&
              sourceDefaultBranch &&
              sourceCurrentBranch !== sourceDefaultBranch ? (
                <form
                  className="personal-source-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      !sourceReviewTitle.trim() ||
                      !sourceRemote.credentialGeneration
                    )
                      return;
                    setSourceBusy(true);
                    void sourceControl({
                      kind: "review_request_create",
                      remoteIdentityHash: sourceRemote.remoteIdentityHash,
                      title: sourceReviewTitle.trim(),
                      body: "",
                      sourceBranch: sourceCurrentBranch,
                      targetBranch: sourceDefaultBranch,
                      draft: false,
                      expectedHeadObjectId: sourceHead,
                      credentialGeneration: sourceRemote.credentialGeneration,
                      idempotencyKey: `desktop-source-review-create:${crypto.randomUUID()}`
                    })
                      .then(() => {
                        setSourceReviewTitle("");
                        return loadSourceControl();
                      })
                      .catch(() =>
                        setError("Koed could not create that review request.")
                      )
                      .finally(() => setSourceBusy(false));
                  }}
                >
                  <input
                    aria-label="Review request title"
                    onChange={(event) =>
                      setSourceReviewTitle(event.currentTarget.value)
                    }
                    placeholder={`Open ${sourceCurrentBranch} into ${sourceDefaultBranch}`}
                    value={sourceReviewTitle}
                  />
                  <button
                    disabled={sourceBusy || !sourceReviewTitle.trim()}
                    type="submit"
                  >
                    Open review request
                  </button>
                </form>
              ) : null}
              <div className="personal-source-split">
                <nav aria-label="Open review requests">
                  {reviewRequests.length ? (
                    reviewRequests.map((review) => (
                      <button
                        aria-current={
                          review.id === activeReview?.id ? "true" : undefined
                        }
                        key={review.id}
                        onClick={() => setActiveReview(review)}
                        type="button"
                      >
                        <span>#{review.number}</span>
                        {review.title}
                      </button>
                    ))
                  ) : (
                    <p>No open review requests.</p>
                  )}
                </nav>
                <section className="personal-source-detail">
                  {activeReview ? (
                    <>
                      <header>
                        <strong>{activeReview.title}</strong>
                        <span>
                          {activeReview.sourceBranch} →{" "}
                          {activeReview.targetBranch}
                        </span>
                      </header>
                      <div className="personal-source-checks">
                        {sourceChecks.map((check) => (
                          <span data-state={check.state} key={check.id}>
                            {check.name}: {check.conclusion ?? check.state}
                          </span>
                        ))}
                      </div>
                      <div className="personal-source-comments">
                        {sourceComments.map((comment) => (
                          <article key={comment.id}>
                            <strong>{comment.author}</strong>
                            <p>{comment.body}</p>
                          </article>
                        ))}
                      </div>
                      {sourceRemote.capabilities.includes("reviews_write") ? (
                        <div className="personal-source-review-actions">
                          <button
                            disabled={sourceBusy}
                            onClick={() => {
                              if (!sourceRemote.credentialGeneration) return;
                              setSourceBusy(true);
                              void sourceControl({
                                kind: "review_create",
                                remoteIdentityHash:
                                  sourceRemote.remoteIdentityHash,
                                number: activeReview.number,
                                decision: "approve",
                                body: "Approved in Koed.",
                                expectedHeadObjectId: activeReview.headObjectId,
                                credentialGeneration:
                                  sourceRemote.credentialGeneration,
                                idempotencyKey: `desktop-source-review:${crypto.randomUUID()}`
                              })
                                .catch(() =>
                                  setError("Koed could not submit that review.")
                                )
                                .finally(() => setSourceBusy(false));
                            }}
                            type="button"
                          >
                            Approve
                          </button>
                          <button
                            disabled={sourceBusy || !sourceComment.trim()}
                            onClick={() => {
                              if (
                                !sourceRemote.credentialGeneration ||
                                !sourceComment.trim()
                              )
                                return;
                              setSourceBusy(true);
                              void sourceControl({
                                kind: "review_create",
                                remoteIdentityHash:
                                  sourceRemote.remoteIdentityHash,
                                number: activeReview.number,
                                decision: "request_changes",
                                body: sourceComment.trim(),
                                expectedHeadObjectId: activeReview.headObjectId,
                                credentialGeneration:
                                  sourceRemote.credentialGeneration,
                                idempotencyKey: `desktop-source-review:${crypto.randomUUID()}`
                              })
                                .then(() => setSourceComment(""))
                                .catch(() =>
                                  setError("Koed could not submit that review.")
                                )
                                .finally(() => setSourceBusy(false));
                            }}
                            type="button"
                          >
                            Request changes
                          </button>
                        </div>
                      ) : null}
                      {sourceRemote.capabilities.includes("comments_write") ? (
                        <form
                          className="personal-source-comment"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (
                              !sourceComment.trim() ||
                              !sourceRemote.credentialGeneration
                            )
                              return;
                            setSourceBusy(true);
                            void sourceControl({
                              kind: "comment_create",
                              remoteIdentityHash:
                                sourceRemote.remoteIdentityHash,
                              number: activeReview.number,
                              body: sourceComment.trim(),
                              expectedHeadObjectId: activeReview.headObjectId,
                              credentialGeneration:
                                sourceRemote.credentialGeneration,
                              idempotencyKey: `desktop-source-comment:${crypto.randomUUID()}`
                            })
                              .then(() => {
                                setSourceComment("");
                                return loadReviewDetail(activeReview);
                              })
                              .catch(() =>
                                setError("Koed could not post that comment.")
                              )
                              .finally(() => setSourceBusy(false));
                          }}
                        >
                          <textarea
                            aria-label="Review comment"
                            onChange={(event) =>
                              setSourceComment(event.currentTarget.value)
                            }
                            placeholder="Add a comment"
                            rows={3}
                            value={sourceComment}
                          />
                          <button
                            disabled={sourceBusy || !sourceComment.trim()}
                            type="submit"
                          >
                            Comment
                          </button>
                        </form>
                      ) : null}
                    </>
                  ) : null}
                </section>
              </div>
            </>
          )}
          {sourceBusy ? (
            <LoaderCircle
              aria-label="Loading source control"
              className="personal-cockpit-spin"
            />
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="personal-cockpit-error" role="alert">
          {error}
        </p>
      ) : null}
    </aside>
  );
}
