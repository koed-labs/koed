"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Archive, Clock3, Pause, Play, Plus, RefreshCw, X } from "lucide-react";
import {
  nextRecurringAgentTaskAt,
  recurringAgentScheduleSchema,
  type CreateRecurringAgentTask,
  type RecurringAgentOccurrence,
  type RecurringAgentSchedule,
  type RecurringAgentTask
} from "@koed/shared/recurring-agent-tasks";
import { loadHostedLaunchOptions } from "@/lib/hosted-managed-chats";
import {
  managedRequest,
  parseLaunchInstances,
  type LaunchInstance
} from "@/lib/managed-agent-chat";
import {
  recurringAgentTasksClient,
  recurringTaskClientAlias
} from "@/lib/recurring-agent-tasks-client";
import { useVisibleRefresh } from "@/lib/use-visible-refresh";

type ProjectOption = Readonly<{ id: string; name: string }>;
type Draft = {
  title: string;
  prompt: string;
  scheduleKind: RecurringAgentSchedule["kind"];
  everyMinutes: string;
  intervalAnchorAt: string;
  localTime: string;
  timeZone: string;
  weekdays: number[];
  projectId: string;
  clientId: string;
  model: string;
  reasoningEffort: string;
  permissionMode: string;
};
type HistoryState = {
  occurrences: RecurringAgentOccurrence[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
};
type CreateAttempt = Omit<CreateRecurringAgentTask, "requestId"> & {
  requestId: string;
};

const weekdayNames = [
  { id: 1, label: "Mon" },
  { id: 2, label: "Tue" },
  { id: 3, label: "Wed" },
  { id: 4, label: "Thu" },
  { id: 5, label: "Fri" },
  { id: 6, label: "Sat" },
  { id: 7, label: "Sun" }
];

function hostedStudio(): boolean {
  return (
    typeof window !== "undefined" &&
    /^\/studio(?:\/|$)/u.test(window.location.pathname)
  );
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function initialDraft(task?: RecurringAgentTask): Draft {
  const schedule = task?.schedule;
  return {
    title: task?.title ?? "",
    prompt: task?.prompt ?? "",
    scheduleKind: schedule?.kind ?? "interval",
    everyMinutes:
      schedule?.kind === "interval" ? String(schedule.everyMinutes) : "60",
    intervalAnchorAt:
      schedule?.kind === "interval"
        ? schedule.anchorAt
        : new Date().toISOString(),
    localTime:
      schedule && schedule.kind !== "interval" ? schedule.localTime : "09:00",
    timeZone:
      schedule && schedule.kind !== "interval"
        ? schedule.timeZone
        : defaultTimeZone(),
    weekdays: schedule?.kind === "weekly" ? [...schedule.weekdays] : [1],
    projectId: task?.context.projectId ?? "",
    clientId: task?.execution.aiClientInstanceId ?? "",
    model: task?.execution.model ?? "",
    reasoningEffort: task
      ? (task.execution.reasoningEffort ?? "__client_default__")
      : "",
    permissionMode: task?.execution.permissionMode ?? ""
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed. Refresh and try again.";
}

function statusLabel(status: RecurringAgentTask["status"]): string {
  return status === "needs_review"
    ? "Needs review"
    : status.charAt(0).toUpperCase() + status.slice(1);
}

function dateTime(value: string | null): string {
  if (!value) return "Not scheduled";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(timestamp)
    : "Time unavailable";
}

function cadenceSummary(schedule: RecurringAgentSchedule): string {
  if (schedule.kind === "interval") {
    if (schedule.everyMinutes % 1440 === 0)
      return `Every ${schedule.everyMinutes / 1440} day(s)`;
    if (schedule.everyMinutes % 60 === 0)
      return `Every ${schedule.everyMinutes / 60} hour(s)`;
    return `Every ${schedule.everyMinutes} minute(s)`;
  }
  const time = `${schedule.localTime} ${schedule.timeZone}`;
  if (schedule.kind === "daily") return `Daily at ${time}`;
  const selectedDays = schedule.weekdays
    .map((day) => weekdayNames.find((entry) => entry.id === day)?.label)
    .filter((day): day is string => Boolean(day));
  return `${selectedDays.join(", ")} at ${time}`;
}

function occurrenceStatusLabel(
  status: RecurringAgentOccurrence["status"]
): string {
  switch (status) {
    case "reserved":
      return "Waiting to start";
    case "dispatched":
      return "Started";
    case "needs_review":
      return "Needs review";
    case "canceled":
      return "Canceled";
    case "completed":
      return "Completed";
  }
}

function occurrenceHasConversation(
  occurrence: RecurringAgentOccurrence
): boolean {
  return (
    occurrence.status === "dispatched" ||
    occurrence.status === "completed" ||
    occurrence.messageId !== null ||
    occurrence.deliveryId !== null ||
    occurrence.executionId !== null
  );
}

function validUuidRequestId(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function")
    throw new Error("Secure request IDs are unavailable in this browser.");
  return crypto.randomUUID();
}

async function loadLaunchChoices(signal: AbortSignal): Promise<{
  instances: LaunchInstance[];
  projects: ProjectOption[];
}> {
  if (hostedStudio()) {
    const result = await loadHostedLaunchOptions(signal);
    return {
      instances: result.instances.filter((instance) => instance.ready),
      projects: result.projects
    };
  }
  const payload = await managedRequest("/launch-options", undefined, signal);
  const projects = Array.isArray(payload.projects)
    ? payload.projects.flatMap((value) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("id" in value) ||
          !("name" in value) ||
          typeof value.id !== "string" ||
          typeof value.name !== "string" ||
          !value.id.trim() ||
          !value.name.trim()
        )
          return [];
        return [{ id: value.id, name: value.name }];
      })
    : [];
  return { instances: parseLaunchInstances(payload), projects };
}

function availablePermissionLabel(mode: string): string {
  switch (mode) {
    case "supervised":
      return "Ask for approval";
    case "auto_edit":
      return "Automatic edits";
    case "auto":
      return "Automatic actions";
    case "full_access":
      return "Full access";
    default:
      return mode;
  }
}

export function RecurringAgentTasks({
  agentId,
  agentName,
  agentActive,
  ownerVerified,
  onOpenConversation
}: {
  agentId: string;
  agentName: string;
  agentActive: boolean;
  ownerVerified: boolean;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const [tasks, setTasks] = useState<RecurringAgentTask[]>([]);
  const [tasksNextCursor, setTasksNextCursor] = useState<string | null>(null);
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formTask, setFormTask] = useState<RecurringAgentTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => initialDraft());
  const [instances, setInstances] = useState<LaunchInstance[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchRevision, setLaunchRevision] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [createAttempt, setCreateAttempt] = useState<CreateAttempt | null>(
    null
  );
  const [runNowRequestIds, setRunNowRequestIds] = useState<
    Record<string, string>
  >({});
  const [saving, setSaving] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [resumeConsent, setResumeConsent] = useState<Record<string, boolean>>(
    {}
  );
  const [acknowledgeReview, setAcknowledgeReview] = useState<
    Record<string, boolean>
  >({});
  const [reviewOpened, setReviewOpened] = useState<Record<string, boolean>>({});
  const [historyOpen, setHistoryOpen] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<Record<string, HistoryState>>({});
  const [refreshing, setRefreshing] = useState(false);
  const pendingControllers = useRef(new Set<AbortController>());
  const refreshController = useRef<AbortController | null>(null);
  const tasksRef = useRef(tasks);
  const historyOpenRef = useRef(historyOpen);
  const historyRef = useRef(history);
  tasksRef.current = tasks;
  historyOpenRef.current = historyOpen;
  historyRef.current = history;

  useEffect(
    () => () => {
      for (const controller of pendingControllers.current) controller.abort();
      pendingControllers.current.clear();
    },
    [ownerVerified]
  );

  function beginOperation(): AbortController {
    const controller = new AbortController();
    pendingControllers.current.add(controller);
    return controller;
  }

  function finishOperation(controller: AbortController) {
    pendingControllers.current.delete(controller);
  }

  function upsertTask(task: RecurringAgentTask) {
    setTasks((current) => {
      const index = current.findIndex((item) => item.id === task.id);
      if (index < 0) return [task, ...current];
      return current.map((item) => (item.id === task.id ? task : item));
    });
    setRunNowRequestIds((current) => {
      if (!(task.id in current)) return current;
      const next = { ...current };
      delete next[task.id];
      return next;
    });
  }

  useEffect(() => {
    if (!ownerVerified) return;
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError(null);
    void recurringAgentTasksClient
      .listPage(agentId, undefined, controller.signal)
      .then((result) => {
        if (current) {
          setTasks([...result.tasks]);
          setTasksNextCursor(result.nextCursor);
          setRunNowRequestIds((existing) => {
            const next = { ...existing };
            for (const oldTask of tasksRef.current) {
              const refreshed = result.tasks.find(
                (task) => task.id === oldTask.id
              );
              if (refreshed && refreshed.revision !== oldTask.revision)
                delete next[oldTask.id];
            }
            return next;
          });
        }
      })
      .catch((reason: unknown) => {
        if (current && !controller.signal.aborted)
          setError(errorMessage(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [agentId, ownerVerified]);

  const refreshVisible = useCallback(async (): Promise<boolean> => {
    if (!ownerVerified) return true;
    if (refreshController.current) return false;
    const controller = beginOperation();
    refreshController.current = controller;
    setRefreshing(true);
    try {
      const firstPage = await recurringAgentTasksClient.listPage(
        agentId,
        undefined,
        controller.signal
      );
      if (controller.signal.aborted) return false;
      const refreshedTasks = [...firstPage.tasks];
      const previousTasks = tasksRef.current;
      setTasks(refreshedTasks);
      setTasksNextCursor(firstPage.nextCursor);
      setRunNowRequestIds((existing) => {
        const next = { ...existing };
        for (const oldTask of previousTasks) {
          const current = refreshedTasks.find((task) => task.id === oldTask.id);
          if (current && current.revision !== oldTask.revision)
            delete next[oldTask.id];
        }
        return next;
      });

      const openHistoryIds = Object.entries(historyOpenRef.current)
        .filter(
          ([taskId, open]) =>
            open &&
            historyRef.current[taskId]?.loaded &&
            !historyRef.current[taskId]?.loading
        )
        .map(([taskId]) => taskId)
        .slice(0, 5);
      const historyPages = await Promise.all(
        openHistoryIds.map(async (taskId) => {
          try {
            return {
              taskId,
              page: await recurringAgentTasksClient.occurrences(
                taskId,
                undefined,
                controller.signal
              ),
              error: null
            };
          } catch (reason) {
            return { taskId, page: null, error: errorMessage(reason) };
          }
        })
      );
      if (controller.signal.aborted) return false;
      setHistory((current) => {
        const next = { ...current };
        for (const result of historyPages) {
          const previous = current[result.taskId];
          if (!previous) continue;
          if (!result.page) {
            next[result.taskId] = {
              ...previous,
              loading: false,
              error: result.error
            };
            continue;
          }
          const newestIds = new Set(
            result.page.occurrences.map((item) => item.id)
          );
          const older = previous.occurrences.filter(
            (item) => !newestIds.has(item.id)
          );
          next[result.taskId] = {
            occurrences: [...result.page.occurrences, ...older],
            nextCursor: previous.nextCursor ?? result.page.nextCursor,
            loaded: true,
            loading: false,
            error: null
          };
        }
        return next;
      });
      setError(null);
      return historyPages.every((result) => result.page !== null);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
      return false;
    } finally {
      finishOperation(controller);
      if (refreshController.current === controller)
        refreshController.current = null;
      if (!controller.signal.aborted) setRefreshing(false);
    }
  }, [agentId, ownerVerified]);

  useVisibleRefresh(
    refreshVisible,
    ownerVerified && !loading && tasks.length <= 10 && !creating && !formTask
  );

  const selectedInstance = useMemo(
    () =>
      instances.find(
        (instance) =>
          recurringTaskClientAlias(instance, hostedStudio()) === draft.clientId
      ),
    [draft.clientId, instances]
  );
  const selectedModel = selectedInstance?.models.find(
    (model) => model.id === draft.model
  );
  const availableProjects = useMemo(() => {
    const result = [...projects];
    if (
      draft.projectId &&
      !result.some((project) => project.id === draft.projectId)
    )
      result.push({
        id: draft.projectId,
        name: "Current Project (unavailable)"
      });
    return result;
  }, [draft.projectId, projects]);

  useEffect(() => {
    if (!creating && !formTask) return;
    const controller = new AbortController();
    let current = true;
    setLaunchLoading(true);
    setLaunchError(null);
    void loadLaunchChoices(controller.signal)
      .then((result) => {
        if (!current) return;
        setInstances(
          result.instances.filter((instance) =>
            ["codex", "claude"].includes(instance.driverId)
          )
        );
        setProjects(result.projects);
      })
      .catch((reason: unknown) => {
        if (current && !controller.signal.aborted)
          setLaunchError(errorMessage(reason));
      })
      .finally(() => {
        if (current) setLaunchLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [creating, formTask, launchRevision]);

  function openCreate() {
    setFormTask(null);
    setDraft(initialDraft());
    setFormError(null);
    setCreateAttempt(null);
    setCreating(true);
  }

  function openEdit(task: RecurringAgentTask) {
    setFormTask(task);
    setDraft(initialDraft(task));
    setFormError(null);
    setCreating(false);
  }

  function closeForm() {
    if (saving || createAttempt) return;
    setFormTask(null);
    setCreating(false);
    setFormError(null);
  }

  function updateDraft<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function buildSchedule(): RecurringAgentSchedule {
    let schedule: unknown;
    if (draft.scheduleKind === "interval") {
      const everyMinutes = Number(draft.everyMinutes);
      const anchorAt =
        formTask?.schedule.kind === "interval" &&
        formTask.schedule.everyMinutes === everyMinutes
          ? formTask.schedule.anchorAt
          : draft.intervalAnchorAt;
      schedule = {
        kind: "interval",
        everyMinutes,
        anchorAt
      };
    } else if (draft.scheduleKind === "daily") {
      schedule = {
        kind: "daily",
        localTime: draft.localTime,
        timeZone: draft.timeZone
      };
    } else {
      schedule = {
        kind: "weekly",
        localTime: draft.localTime,
        timeZone: draft.timeZone,
        weekdays: draft.weekdays
      };
    }
    const parsed = recurringAgentScheduleSchema.safeParse(schedule);
    if (!parsed.success) {
      if (draft.scheduleKind === "interval")
        throw new Error("Choose an interval between 5 and 525,600 minutes.");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(draft.localTime))
        throw new Error("Enter a valid local time in HH:mm format.");
      try {
        new Intl.DateTimeFormat("en", { timeZone: draft.timeZone });
      } catch {
        throw new Error("Choose a valid IANA time zone.");
      }
      if (draft.scheduleKind === "weekly" && draft.weekdays.length === 0)
        throw new Error("Select at least one weekday.");
      throw new Error("Check the selected schedule settings.");
    }
    return parsed.data;
  }

  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const controller = beginOperation();
    let attemptedCreate: CreateAttempt | null = null;
    try {
      setSaving(true);
      if (formTask) {
        if (!selectedInstance || !selectedModel) {
          setFormError("Choose an available AI Client and model.");
          return;
        }
        if (!draft.permissionMode) {
          setFormError("Choose the permission mode for this task.");
          return;
        }
        const definition = makeDefinition();
        const saved = await recurringAgentTasksClient.update(
          formTask.id,
          {
            ...definition,
            expectedRevision: formTask.revision
          },
          controller.signal
        );
        if (controller.signal.aborted) return;
        upsertTask(saved);
      } else {
        attemptedCreate = createAttempt ?? {
          ...makeDefinition(),
          requestId: validUuidRequestId()
        };
        if (!createAttempt) setCreateAttempt(attemptedCreate);
        const saved = await recurringAgentTasksClient.create(
          agentId,
          attemptedCreate,
          controller.signal
        );
        if (controller.signal.aborted) return;
        upsertTask(saved);
        setCreateAttempt(null);
      }
      if (controller.signal.aborted) return;
      setFormTask(null);
      setCreating(false);
    } catch (reason) {
      if (!controller.signal.aborted) {
        const status =
          reason && typeof reason === "object" && "status" in reason
            ? reason.status
            : undefined;
        if (
          attemptedCreate &&
          typeof status === "number" &&
          [400, 401, 403, 404, 422].includes(status)
        )
          setCreateAttempt(null);
        setFormError(
          attemptedCreate &&
            (status === undefined ||
              ![400, 401, 403, 404, 422].includes(Number(status)))
            ? `${errorMessage(reason)} The create result was not confirmed; retry this same request before changing these settings.`
            : errorMessage(reason)
        );
      }
    } finally {
      finishOperation(controller);
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  function makeDefinition(): Omit<CreateRecurringAgentTask, "requestId"> {
    if (!selectedInstance || !selectedModel)
      throw new Error("Choose an available AI Client and model.");
    if (!draft.permissionMode)
      throw new Error("Choose the permission mode for this task.");
    const projectId = draft.projectId || null;
    const execution = {
      provider: selectedInstance.driverId as "codex" | "claude",
      aiClientInstanceId: recurringTaskClientAlias(
        selectedInstance,
        hostedStudio()
      ),
      targetDeviceId: selectedInstance.runnerDeviceId ?? "",
      model: selectedModel.id,
      reasoningEffort:
        !draft.reasoningEffort || draft.reasoningEffort === "__client_default__"
          ? null
          : draft.reasoningEffort,
      permissionMode: draft.permissionMode as
        | "supervised"
        | "auto_edit"
        | "auto"
        | "full_access"
    };
    if (!execution.targetDeviceId)
      throw new Error(
        "The selected AI Client has no verified Personal Device. Refresh launch options and choose it again."
      );
    return {
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      schedule: buildSchedule(),
      context: {
        projectId,
        contextKind: projectId ? "project" : "independent"
      },
      execution
    };
  }

  async function changeTask(
    task: RecurringAgentTask,
    action: "pause" | "resume" | "archive"
  ) {
    if (busyTaskId) return;
    if (
      action === "resume" &&
      (task.status === "needs_review"
        ? !acknowledgeReview[task.id]
        : !resumeConsent[task.id])
    )
      return;
    setBusyTaskId(task.id);
    setError(null);
    const controller = beginOperation();
    try {
      const updated = await recurringAgentTasksClient.control(
        task.id,
        {
          action,
          expectedRevision: task.revision,
          ...(action === "resume"
            ? {
                activationConsent: true,
                ...(task.status === "needs_review"
                  ? { acknowledgeReview: true }
                  : {})
              }
            : {})
        },
        controller.signal
      );
      if (controller.signal.aborted) return;
      upsertTask(updated);
      setResumeConsent((value) => ({ ...value, [task.id]: false }));
      setAcknowledgeReview((value) => ({ ...value, [task.id]: false }));
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishOperation(controller);
      if (!controller.signal.aborted) setBusyTaskId(null);
    }
  }

  async function runNow(task: RecurringAgentTask) {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    setError(null);
    const controller = beginOperation();
    try {
      const requestId = runNowRequestIds[task.id] ?? validUuidRequestId();
      setRunNowRequestIds((value) => ({ ...value, [task.id]: requestId }));
      await recurringAgentTasksClient.runNow(
        task.id,
        requestId,
        task.revision,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setRunNowRequestIds((value) => {
        const next = { ...value };
        delete next[task.id];
        return next;
      });
      setHistory((value) => ({
        ...value,
        [task.id]: {
          occurrences: [],
          nextCursor: null,
          loaded: false,
          loading: false,
          error: null
        }
      }));
      if (historyOpenRef.current[task.id]) void loadHistory(task.id);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishOperation(controller);
      if (!controller.signal.aborted) setBusyTaskId(null);
    }
  }

  async function loadHistory(taskId: string, before?: string) {
    const controller = beginOperation();
    setHistory((value) => ({
      ...value,
      [taskId]: {
        occurrences: value[taskId]?.occurrences ?? [],
        nextCursor: value[taskId]?.nextCursor ?? null,
        loaded: value[taskId]?.loaded ?? false,
        loading: true,
        error: null
      }
    }));
    try {
      const page = await recurringAgentTasksClient.occurrences(
        taskId,
        before,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setHistory((value) => {
        const prior = value[taskId];
        return {
          ...value,
          [taskId]: {
            occurrences: before
              ? [...(prior?.occurrences ?? []), ...page.occurrences]
              : page.occurrences,
            nextCursor: page.nextCursor,
            loaded: true,
            loading: false,
            error: null
          }
        };
      });
    } catch (reason) {
      if (controller.signal.aborted) return;
      setHistory((value) => ({
        ...value,
        [taskId]: {
          occurrences: value[taskId]?.occurrences ?? [],
          nextCursor: value[taskId]?.nextCursor ?? null,
          loaded: value[taskId]?.loaded ?? false,
          loading: false,
          error: errorMessage(reason)
        }
      }));
    } finally {
      finishOperation(controller);
    }
  }

  function toggleHistory(taskId: string) {
    const next = !historyOpen[taskId];
    setHistoryOpen((value) => ({ ...value, [taskId]: next }));
    if (next && !history[taskId]?.loaded && !history[taskId]?.loading)
      void loadHistory(taskId);
  }

  function reviewWasOpened(task: RecurringAgentTask): boolean {
    if (reviewOpened[task.id]) return true;
    try {
      return (
        sessionStorage.getItem(
          `koed.recurring-agent-task.reviewed.v1:${task.id}:${task.revision}`
        ) === "true"
      );
    } catch {
      return false;
    }
  }

  function openOccurrenceConversation(
    task: RecurringAgentTask,
    occurrence: RecurringAgentOccurrence
  ) {
    if (!occurrenceHasConversation(occurrence)) return;
    if (
      task.status === "needs_review" &&
      occurrence.status === "needs_review"
    ) {
      setReviewOpened((value) => ({ ...value, [task.id]: true }));
      try {
        sessionStorage.setItem(
          `koed.recurring-agent-task.reviewed.v1:${task.id}:${task.revision}`,
          "true"
        );
      } catch {
        // The in-memory acknowledgement still protects the current panel.
      }
    }
    onOpenConversation?.(occurrence.conversationId);
  }

  async function loadMoreTasks() {
    if (!tasksNextCursor || loadingMoreTasks) return;
    const controller = beginOperation();
    setLoadingMoreTasks(true);
    try {
      const page = await recurringAgentTasksClient.listPage(
        agentId,
        tasksNextCursor,
        controller.signal
      );
      if (controller.signal.aborted) return;
      setTasks((current) => {
        const known = new Set(current.map((task) => task.id));
        return [
          ...current,
          ...page.tasks.filter((task) => !known.has(task.id))
        ];
      });
      setTasksNextCursor(page.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    } finally {
      finishOperation(controller);
      if (!controller.signal.aborted) setLoadingMoreTasks(false);
    }
  }

  if (!ownerVerified) return null;

  const previewSchedule = (() => {
    try {
      return dateTime(nextRecurringAgentTaskAt(buildSchedule(), Date.now()));
    } catch {
      return null;
    }
  })();
  const createLocked = Boolean(createAttempt);

  return (
    <section
      aria-label="Recurring Agent tasks"
      className="space-y-3 border-t border-border px-5 py-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">
          Recurring tasks
        </h2>
        <button
          type="button"
          onClick={() => void refreshVisible()}
          disabled={loading || refreshing}
          aria-label="Refresh recurring tasks"
          className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading || refreshing ? "animate-spin" : ""}`}
          />
        </button>
      </div>
      <p className="text-xs leading-relaxed text-subtle">
        Private to you. Team availability may share this Agent’s approved
        description; task schedules, prompts, and Conversations stay private.
      </p>
      <p className="text-[10px] text-subtle">
        Refresh reloads the newest 10 schedules and returns to the first page.
        Use Load more to browse older tasks.
      </p>
      <p className="flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-2 text-[11px] leading-relaxed text-subtle">
        <Clock3 className="h-3.5 w-3.5 shrink-0" />
        Runs use this task’s AI Client, device, model, and permission. Any AI
        Client approval still happens in its Conversation.
      </p>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {loading && tasks.length === 0 ? (
        <p className="text-sm text-subtle">Loading private recurring tasks…</p>
      ) : tasks.length === 0 && !error ? (
        <p className="text-sm text-subtle">
          No recurring tasks for {agentName}.
        </p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => {
            const canResume =
              agentActive &&
              (task.status === "paused" || task.status === "needs_review");
            const taskHistory = history[task.id];
            const reviewConversation = taskHistory?.occurrences.find(
              (occurrence) =>
                occurrence.status === "needs_review" &&
                occurrenceHasConversation(occurrence)
            );
            const reviewWithoutConversation = taskHistory?.occurrences.some(
              (occurrence) =>
                occurrence.status === "needs_review" &&
                !occurrenceHasConversation(occurrence)
            );
            return (
              <article
                key={task.id}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-foreground">
                      {task.title}
                    </p>
                    <p className="mt-1 text-[11px] text-subtle">
                      {statusLabel(task.status)} · Next:{" "}
                      {dateTime(task.nextRunAt)}
                    </p>
                    <p className="mt-1 text-[11px] text-subtle">
                      {cadenceSummary(task.schedule)}
                    </p>
                    <p className="mt-0.5 break-words text-[11px] text-subtle">
                      {task.execution.provider === "codex" ? "Codex" : "Claude"}{" "}
                      · {task.execution.model} ·{" "}
                      {availablePermissionLabel(task.execution.permissionMode)}
                    </p>
                    {task.lastRunAt && (
                      <p className="mt-0.5 text-[11px] text-subtle">
                        Last run: {dateTime(task.lastRunAt)}
                      </p>
                    )}
                    {task.lastErrorCode && (
                      <p className="mt-1 text-[11px] text-warning">
                        Last run needs attention. Review its history for status
                        and next steps.
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-[10px] font-medium text-muted">
                    Version {task.revision}
                  </span>
                </div>

                {task.status === "paused" && (
                  <label className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-subtle">
                    <input
                      type="checkbox"
                      checked={resumeConsent[task.id] ?? false}
                      disabled={!agentActive || busyTaskId === task.id}
                      onChange={(event) =>
                        setResumeConsent((value) => ({
                          ...value,
                          [task.id]: event.target.checked
                        }))
                      }
                      className="mt-0.5 accent-[var(--accent)]"
                    />
                    I reviewed these settings and want to activate this
                    schedule.
                  </label>
                )}
                {task.status === "needs_review" && (
                  <div className="mt-3 space-y-2">
                    {reviewConversation ? (
                      onOpenConversation ? (
                        <button
                          type="button"
                          onClick={() =>
                            openOccurrenceConversation(task, reviewConversation)
                          }
                          className="text-[11px] font-medium text-accent underline underline-offset-2"
                        >
                          Open Conversation to review
                        </button>
                      ) : (
                        <span className="text-[11px] text-subtle">
                          Open the run’s Conversation to review before resuming.
                        </span>
                      )
                    ) : reviewWithoutConversation ? (
                      <p className="text-[11px] text-warning">
                        The run needs review, but no Conversation was created.
                        Edit the task settings before activating it again.
                      </p>
                    ) : null}
                    {!taskHistory?.loaded && (
                      <button
                        type="button"
                        onClick={() => {
                          setHistoryOpen((value) => ({
                            ...value,
                            [task.id]: true
                          }));
                          void loadHistory(task.id);
                        }}
                        className="text-[11px] font-medium text-accent underline underline-offset-2"
                      >
                        Load recent Conversations
                      </button>
                    )}
                    <label className="flex items-start gap-2 text-[11px] leading-relaxed text-subtle">
                      <input
                        type="checkbox"
                        checked={acknowledgeReview[task.id] ?? false}
                        disabled={
                          busyTaskId === task.id || !reviewWasOpened(task)
                        }
                        onChange={(event) => {
                          setAcknowledgeReview((value) => ({
                            ...value,
                            [task.id]: event.target.checked
                          }));
                          setResumeConsent((value) => ({
                            ...value,
                            [task.id]: event.target.checked
                          }));
                        }}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      I reviewed the run and want this schedule to resume.
                    </label>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {task.status === "active" && (
                    <button
                      type="button"
                      disabled={busyTaskId === task.id}
                      onClick={() => void changeTask(task, "pause")}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                    >
                      <Pause className="h-3 w-3" /> Pause
                    </button>
                  )}
                  {canResume && (
                    <button
                      type="button"
                      disabled={
                        busyTaskId === task.id ||
                        !resumeConsent[task.id] ||
                        (task.status === "needs_review" &&
                          (!acknowledgeReview[task.id] ||
                            !reviewWasOpened(task)))
                      }
                      onClick={() => void changeTask(task, "resume")}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" />
                      {task.status === "needs_review"
                        ? "Acknowledge and resume"
                        : "Activate"}
                    </button>
                  )}
                  {task.status === "active" && agentActive && (
                    <button
                      type="button"
                      disabled={busyTaskId === task.id}
                      onClick={() => void runNow(task)}
                      className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busyTaskId === task.id ? "Starting…" : "Run now"}
                    </button>
                  )}
                  {task.status === "paused" && (
                    <button
                      type="button"
                      onClick={() => openEdit(task)}
                      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-hover"
                    >
                      Edit
                    </button>
                  )}
                  {task.status === "needs_review" && (
                    <button
                      type="button"
                      onClick={() => openEdit(task)}
                      className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground-secondary hover:bg-surface-hover"
                    >
                      Edit settings
                    </button>
                  )}
                  {task.status !== "archived" && (
                    <button
                      type="button"
                      disabled={busyTaskId === task.id}
                      onClick={() => void changeTask(task, "archive")}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-subtle hover:bg-surface-hover disabled:opacity-50"
                    >
                      <Archive className="h-3 w-3" /> Archive
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => toggleHistory(task.id)}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-surface-hover"
                  >
                    {historyOpen[task.id] ? "Hide history" : "Run history"}
                  </button>
                </div>

                {task.status !== "archived" && !agentActive && (
                  <p className="mt-2 text-[11px] text-warning">
                    This Agent is retired. Restore it before activating or
                    starting new runs.
                  </p>
                )}
                {task.status === "paused" && (
                  <p className="mt-2 text-[11px] text-subtle">
                    Paused tasks do not run. New and edited tasks need your
                    explicit activation.
                  </p>
                )}
                {historyOpen[task.id] && (
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
                      Private run history
                    </p>
                    {taskHistory?.error && (
                      <p role="alert" className="mt-2 text-xs text-danger">
                        {taskHistory.error}
                      </p>
                    )}
                    {taskHistory?.occurrences.length ? (
                      <div className="mt-2 space-y-2">
                        {taskHistory.occurrences.map((occurrence) => (
                          <div
                            key={occurrence.id}
                            className="flex items-center justify-between gap-2 rounded-md bg-background/70 px-2.5 py-2"
                          >
                            <div className="min-w-0">
                              <p className="text-[11px] text-foreground-secondary">
                                {occurrenceStatusLabel(occurrence.status)} ·{" "}
                                {occurrence.trigger === "manual"
                                  ? "Run now"
                                  : "Scheduled"}
                              </p>
                              <p className="text-[10px] text-subtle">
                                {dateTime(occurrence.scheduledAt)}
                              </p>
                            </div>
                            {onOpenConversation &&
                            occurrenceHasConversation(occurrence) ? (
                              <button
                                type="button"
                                onClick={() =>
                                  openOccurrenceConversation(task, occurrence)
                                }
                                className="shrink-0 text-[10px] font-medium text-accent underline underline-offset-2"
                              >
                                Open Conversation
                              </button>
                            ) : (
                              <span className="shrink-0 text-[10px] text-subtle">
                                Conversation not created
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : taskHistory?.loaded ? (
                      <p className="mt-2 text-xs text-subtle">
                        No runs recorded yet.
                      </p>
                    ) : taskHistory?.loading ? (
                      <p className="mt-2 text-xs text-subtle">
                        Loading run history…
                      </p>
                    ) : null}
                    {taskHistory?.nextCursor && (
                      <button
                        type="button"
                        disabled={taskHistory.loading || refreshing}
                        onClick={() =>
                          void loadHistory(task.id, taskHistory.nextCursor!)
                        }
                        className="mt-2 text-[11px] font-medium text-accent underline underline-offset-2 disabled:opacity-50"
                      >
                        Load older runs
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          {tasksNextCursor && (
            <button
              type="button"
              onClick={() => void loadMoreTasks()}
              disabled={loadingMoreTasks}
              className="w-full rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              {loadingMoreTasks ? "Loading more…" : "Load more recurring tasks"}
            </button>
          )}
        </div>
      )}

      {agentActive && !creating && !formTask && (
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-hover"
        >
          <Plus className="h-3.5 w-3.5" /> Create recurring task
        </button>
      )}
      {!agentActive && (
        <p className="text-xs text-subtle">
          Restore this Agent before creating recurring tasks or starting new
          runs.
        </p>
      )}

      {(creating || formTask) && (
        <form
          onSubmit={(event) => void saveTask(event)}
          className="space-y-3 rounded-lg border border-border bg-background p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {formTask ? "Edit recurring task" : "New recurring task"}
            </h3>
            <button
              type="button"
              onClick={closeForm}
              disabled={saving || createLocked}
              aria-label="Close recurring task form"
              className="rounded-md p-1 text-subtle hover:bg-surface-hover disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <fieldset disabled={createLocked} className="space-y-3">
            <label className="block space-y-1 text-xs font-medium text-foreground-secondary">
              Task name
              <input
                required
                maxLength={120}
                value={draft.title}
                onChange={(event) => updateDraft("title", event.target.value)}
                className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm font-normal text-foreground"
              />
            </label>
            <label className="block space-y-1 text-xs font-medium text-foreground-secondary">
              Instructions
              <textarea
                required
                maxLength={32_000}
                rows={5}
                value={draft.prompt}
                onChange={(event) => updateDraft("prompt", event.target.value)}
                className="w-full resize-y rounded-md border border-border bg-surface px-2.5 py-2 text-sm font-normal text-foreground"
              />
            </label>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-foreground-secondary">
                Schedule
              </legend>
              <select
                aria-label="Schedule frequency"
                value={draft.scheduleKind}
                onChange={(event) =>
                  updateDraft(
                    "scheduleKind",
                    event.target.value as Draft["scheduleKind"]
                  )
                }
                className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground"
              >
                <option value="interval">Every interval</option>
                <option value="daily">Daily at a local time</option>
                <option value="weekly">Weekly on selected days</option>
              </select>
              {draft.scheduleKind === "interval" ? (
                <>
                  <label className="block space-y-1 text-xs text-subtle">
                    Run every number of minutes (5–525,600)
                    <input
                      aria-label="Interval in minutes"
                      type="number"
                      min={5}
                      max={525_600}
                      required
                      value={draft.everyMinutes}
                      onChange={(event) =>
                        updateDraft("everyMinutes", event.target.value)
                      }
                      className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground"
                    />
                  </label>
                  <p className="text-[11px] leading-relaxed text-subtle">
                    Interval timing is anchored when these settings are saved.
                    Activation starts at the next interval boundary.
                  </p>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1 text-xs text-subtle">
                      Local time
                      <input
                        type="time"
                        required
                        value={draft.localTime}
                        onChange={(event) =>
                          updateDraft("localTime", event.target.value)
                        }
                        className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground"
                      />
                    </label>
                    <label className="space-y-1 text-xs text-subtle">
                      IANA time zone
                      <input
                        required
                        maxLength={96}
                        value={draft.timeZone}
                        onChange={(event) =>
                          updateDraft("timeZone", event.target.value)
                        }
                        placeholder="Europe/Oslo"
                        className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground"
                      />
                    </label>
                  </div>
                  {draft.scheduleKind === "weekly" && (
                    <fieldset>
                      <legend className="text-[11px] text-subtle">Days</legend>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {weekdayNames.map((day) => (
                          <label
                            key={day.id}
                            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground-secondary"
                          >
                            <input
                              type="checkbox"
                              checked={draft.weekdays.includes(day.id)}
                              onChange={(event) =>
                                updateDraft(
                                  "weekdays",
                                  event.target.checked
                                    ? [...draft.weekdays, day.id].sort()
                                    : draft.weekdays.filter(
                                        (id) => id !== day.id
                                      )
                                )
                              }
                              className="accent-[var(--accent)]"
                            />
                            {day.label}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <p className="text-[11px] leading-relaxed text-subtle">
                    A skipped local time during daylight saving does not run. A
                    repeated time runs once at its earlier instant.
                  </p>
                </>
              )}
              {previewSchedule && (
                <p className="text-[11px] text-subtle">
                  Next after activation: {previewSchedule}
                </p>
              )}
            </fieldset>

            <label className="block space-y-1 text-xs font-medium text-foreground-secondary">
              Project (optional)
              <select
                aria-label="Project context"
                value={draft.projectId}
                onChange={(event) =>
                  updateDraft("projectId", event.target.value)
                }
                className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm font-normal text-foreground"
              >
                <option value="">No Project · independent task</option>
                {availableProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-2 rounded-md border border-border p-2.5">
              <p className="text-xs font-medium text-foreground-secondary">
                Run this task with
              </p>
              {launchLoading ? (
                <p className="text-xs text-subtle">
                  Loading available AI Clients…
                </p>
              ) : (
                <>
                  <label className="block space-y-1 text-xs text-subtle">
                    AI Client and Personal Device
                    <select
                      aria-label="AI Client and Personal Device"
                      required
                      value={draft.clientId}
                      onChange={(event) => {
                        updateDraft("clientId", event.target.value);
                        updateDraft("model", "");
                        updateDraft("reasoningEffort", "");
                        updateDraft("permissionMode", "");
                      }}
                      className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground"
                    >
                      <option value="">Choose an AI Client and device</option>
                      {instances.map((instance) => (
                        <option
                          key={recurringTaskClientAlias(
                            instance,
                            hostedStudio()
                          )}
                          value={recurringTaskClientAlias(
                            instance,
                            hostedStudio()
                          )}
                        >
                          {instance.driverId} ·{" "}
                          {instance.sourceDeviceLabel || "Personal Device"} ·{" "}
                          {instance.runnerDeviceId || "Device unavailable"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1 text-xs text-subtle">
                    Model
                    <select
                      aria-label="Task model"
                      required
                      disabled={!selectedInstance}
                      value={draft.model}
                      onChange={(event) => {
                        updateDraft("model", event.target.value);
                        updateDraft("reasoningEffort", "");
                      }}
                      className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground disabled:opacity-50"
                    >
                      <option value="">Choose a model</option>
                      {selectedInstance?.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1 text-xs text-subtle">
                    Reasoning effort
                    <select
                      aria-label="Reasoning effort"
                      required
                      disabled={!selectedModel}
                      value={draft.reasoningEffort}
                      onChange={(event) =>
                        updateDraft("reasoningEffort", event.target.value)
                      }
                      className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground disabled:opacity-50"
                    >
                      <option value="">Choose an effort</option>
                      <option value="__client_default__">
                        Use AI Client default
                      </option>
                      {selectedModel?.supportedReasoningEfforts.map(
                        (effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        )
                      )}
                    </select>
                  </label>
                  <label className="block space-y-1 text-xs text-subtle">
                    Permission mode
                    <select
                      aria-label="Permission mode"
                      required
                      disabled={!selectedInstance}
                      value={draft.permissionMode}
                      onChange={(event) =>
                        updateDraft("permissionMode", event.target.value)
                      }
                      className="w-full rounded-md border border-border bg-surface px-2.5 py-2 text-sm text-foreground disabled:opacity-50"
                    >
                      <option value="">Choose a permission mode</option>
                      {selectedInstance?.permissionModes.map((mode) => (
                        <option key={mode} value={mode}>
                          {availablePermissionLabel(mode)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {launchError && (
                <div className="flex items-center justify-between gap-2">
                  <p role="alert" className="text-xs text-danger">
                    {launchError}
                  </p>
                  <button
                    type="button"
                    onClick={() => setLaunchRevision((value) => value + 1)}
                    className="shrink-0 text-[11px] font-medium text-accent underline underline-offset-2"
                  >
                    Retry
                  </button>
                </div>
              )}
              {instances.length === 0 && !launchLoading && !launchError && (
                <p className="text-xs text-warning">
                  No ready Codex or Claude Client with a verified Personal
                  Device is available.
                </p>
              )}
            </div>
          </fieldset>

          {formError && (
            <p role="alert" className="text-xs text-danger">
              {formError}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-subtle">
            Saving leaves the task paused. Review its settings, then activate it
            explicitly. A run that needs an approval will wait for you in its
            Conversation.
          </p>
          {createLocked && (
            <p className="text-[11px] leading-relaxed text-warning">
              The create result was not confirmed. Retry this exact request
              before changing its settings.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              disabled={saving || createLocked}
              className="rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground-secondary hover:bg-surface-hover disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || launchLoading || Boolean(launchError)}
              className="rounded-md bg-accent px-3 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving
                ? "Saving…"
                : formTask
                  ? "Save paused task"
                  : createLocked
                    ? "Retry same create"
                    : "Create paused task"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
