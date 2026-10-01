"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { ArrowLeft, ArrowRight, Check, WifiOff } from "lucide-react";
import { initialsFor, teamTone } from "@/lib/identity";
import type { PublicSquarePublication } from "@/lib/public-square";
import type {
  SquareJob,
  SquareProject,
  SquareZone
} from "@/lib/public-square-view";
import {
  groupWaitingJobsByUser,
  shouldShowPublicSquareMap
} from "@/lib/public-square-view";

const ROOM_MIN_WIDTH = 280;
const GAP = 16;
const PAD = 14;
const HEADER = 68;
const LABEL = 20;
const SLOT_X = 44;
const SLOT_Y = 48;
const LONG_RUNNING_MS = 2 * 60 * 60 * 1000;
const ROOM_TEXTURE = {
  backgroundImage:
    "linear-gradient(color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px)",
  backgroundSize: "22px 22px"
};
const SQUARE_CSS = `
@media (prefers-reduced-motion: no-preference) {
  .ps-bob { animation: ps-bob 1.6s ease-in-out infinite; }
  .ps-move { transition: left 1.2s cubic-bezier(.4,0,.2,1), top 1.2s cubic-bezier(.4,0,.2,1), opacity .5s; }
}
@keyframes ps-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2px) } }
`;

type Station = "working" | "checking" | "waiting";
const STATIONS: { id: Station; label: string }[] = [
  { id: "working", label: "Working" },
  { id: "checking", label: "Checking" },
  { id: "waiting", label: "Waiting / offline" }
];

type RoomFrame = {
  project: SquareProject;
  x: number;
  y: number;
  width: number;
  height: number;
  labels: { id: Station; label: string; count: number; y: number }[];
};

function stationOf(zone: SquareZone): Station | null {
  return zone === "working" || zone === "checking"
    ? zone
    : zone === "waiting" || zone === "offline"
      ? "waiting"
      : null;
}

function layoutSquare(
  width: number,
  projects: SquareProject[],
  jobs: SquareJob[],
  idleAgents: {
    agentId: string;
    agentName: string;
    ownerId: string;
    ownerName: string;
  }[]
) {
  const cols = Math.max(
    1,
    Math.min(
      projects.length || 1,
      Math.floor((width + GAP) / (ROOM_MIN_WIDTH + GAP))
    )
  );
  const roomWidth = (width - GAP * (cols - 1)) / cols;
  const perRow = Math.max(
    1,
    Math.floor((roomWidth - PAD * 2 + (SLOT_X - 32)) / SLOT_X)
  );
  const positions = new Map<string, { x: number; y: number }>();
  const local = projects.map((project) => {
    const inRoom = jobs.filter(
      (job) => job.publication.projectId === project.id
    );
    let y = HEADER + 8;
    const labels: RoomFrame["labels"] = [];
    const slots: { id: string; x: number; y: number }[] = [];
    for (const station of STATIONS) {
      const here = inRoom.filter((job) => stationOf(job.zone) === station.id);
      labels.push({ ...station, count: here.length, y });
      y += LABEL;
      here.forEach((job, index) =>
        slots.push({
          id: job.id,
          x: PAD + (index % perRow) * SLOT_X,
          y: y + Math.floor(index / perRow) * SLOT_Y
        })
      );
      y += Math.max(1, Math.ceil(here.length / perRow)) * SLOT_Y + 6;
    }
    return { project, height: y + 4, labels, slots };
  });
  let top = 0;
  const rooms: RoomFrame[] = [];
  for (let start = 0; start < local.length; start += cols) {
    const row = local.slice(start, start + cols);
    const rowHeight = Math.max(...row.map((room) => room.height));
    row.forEach((room, index) => {
      const x = index * (roomWidth + GAP);
      rooms.push({
        project: room.project,
        x,
        y: top,
        width: roomWidth,
        height: rowHeight,
        labels: room.labels
      });
      room.slots.forEach((slot) =>
        positions.set(slot.id, { x: x + slot.x, y: top + slot.y })
      );
    });
    top += rowHeight + GAP;
  }
  const idleTop = top;
  const idlePerRow = Math.max(
    1,
    Math.floor((width - PAD * 2 + (SLOT_X - 32)) / SLOT_X)
  );
  idleAgents.forEach((agent, index) =>
    positions.set(`${agent.ownerId}:${agent.agentId}`, {
      x: PAD + (index % idlePerRow) * SLOT_X,
      y: idleTop + 36 + Math.floor(index / idlePerRow) * SLOT_Y
    })
  );
  const idleHeight =
    36 + Math.max(1, Math.ceil(idleAgents.length / idlePerRow)) * SLOT_Y + 4;
  return {
    rooms,
    positions,
    idleTop,
    idleHeight,
    height: idleTop + idleHeight
  };
}

function elapsedLabel(startedAt: number, asOf: number) {
  const total = Math.max(0, Math.floor((asOf - startedAt) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}h ${pad(minutes)}m`
    : `${pad(minutes)}:${pad(seconds)}`;
}

function statusClass(job: SquareJob) {
  if (job.publication.status === "queued") return "text-muted";
  if (job.waitingOnViewer) return "text-accent";
  if (job.zone === "waiting") return "text-warning";
  if (job.zone === "working" || job.zone === "checking") return "text-success";
  return "text-muted";
}

function timeAgoLabel(value: string, asOf: number) {
  const age = Math.max(0, asOf - Date.parse(value));
  if (age < 60_000) return "under a minute ago";
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h ago`;
  return `${Math.floor(age / (24 * 60 * 60_000))}d ago`;
}

function hasTerminalOutcome(item: PublicSquarePublication) {
  const status = item.status === "offline" ? item.lastKnownStatus : item.status;
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled" ||
    status === "interrupted"
  );
}

function observedEvent(job: SquareJob, asOf: number | null) {
  if (asOf === null) return null;
  const item = job.publication;
  if (item.status === "running" && item.phase && item.phaseObservedAt) {
    return {
      id: item.id,
      at: Date.parse(item.phaseObservedAt),
      agentName: item.agentName,
      projectName: item.projectName,
      phrase: `is ${item.phase}`
    };
  }
  if (item.status === "running" && item.startedAt) {
    return {
      id: item.id,
      at: Date.parse(item.startedAt),
      agentName: item.agentName,
      projectName: item.projectName,
      phrase: "started a job"
    };
  }
  if (item.status === "offline" && item.lastSeenAt) {
    return {
      id: item.id,
      at: Date.parse(item.lastSeenAt),
      agentName: item.agentName,
      projectName: item.projectName,
      phrase: "was last seen"
    };
  }
  return null;
}

export function PublicSquareView({
  teamName,
  viewerId,
  jobs,
  rooms,
  idleAgents,
  historicalItems,
  serverTime,
  focusJobId,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpenInbox,
  getVisibleBrief,
  renderPublication,
  renderProjectActions
}: {
  teamName: string;
  viewerId: string;
  jobs: SquareJob[];
  rooms: SquareProject[];
  idleAgents: {
    agentId: string;
    agentName: string;
    ownerId: string;
    ownerName: string;
  }[];
  historicalItems: PublicSquarePublication[];
  serverTime?: string;
  focusJobId?: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore?: () => void;
  onOpenInbox?: () => void;
  getVisibleBrief: (item: PublicSquarePublication) => string | null;
  renderPublication: (item: PublicSquarePublication) => ReactNode;
  renderProjectActions: (project: SquareProject) => ReactNode;
}) {
  const [selection, setSelection] = useState<{
    kind: "job" | "room" | "idle";
    id: string;
  } | null>(null);
  const [mapWidth, setMapWidth] = useState(760);
  const [asOf, setAsOf] = useState<number | null>(() =>
    serverTime ? Date.parse(serverTime) : null
  );
  const mapRef = useRef<HTMLDivElement | null>(null);
  const model = useMemo(
    () => ({
      byId: new Map(jobs.map((job) => [job.id, job])),
      projectsById: new Map(rooms.map((room) => [room.id, room])),
      idleById: new Map(
        idleAgents.map((agent) => [`${agent.ownerId}:${agent.agentId}`, agent])
      )
    }),
    [idleAgents, jobs, rooms]
  );
  const selectedJob =
    selection?.kind === "job" ? (model.byId.get(selection.id) ?? null) : null;
  const selectedRoom =
    selection?.kind === "room"
      ? (model.projectsById.get(selection.id) ?? null)
      : null;
  const focusedHistory =
    selection?.kind === "job"
      ? (historicalItems.find((item) => item.id === selection.id) ?? null)
      : null;
  const layout = layoutSquare(mapWidth, rooms, jobs, idleAgents);
  const count = (zones: SquareZone[]) =>
    jobs.filter((job) => zones.includes(job.zone)).length;
  const running = jobs.filter((job) => job.publication.status === "running");
  const working = running.filter((job) => job.zone === "working");
  const waitingOnYou = jobs.filter((job) => job.waitingOnViewer);
  const waitingOnOthers = groupWaitingJobsByUser(jobs, viewerId);
  const offline = jobs.filter((job) => job.zone === "offline");
  const longRunning =
    asOf === null
      ? []
      : running
          .filter(
            (job) =>
              job.startedAt !== null && asOf - job.startedAt > LONG_RUNNING_MS
          )
          .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
          .slice(0, 3);
  const terminalItems = historicalItems.filter(hasTerminalOutcome);
  const frozenItems = historicalItems.filter(
    (item) => item.ownerLeftTeam && !hasTerminalOutcome(item)
  );
  const finishedItems = terminalItems.slice(0, 12);
  const latestEvent =
    [
      ...jobs
        .map((job) => observedEvent(job, asOf))
        .filter((event): event is NonNullable<typeof event> => event !== null),
      ...terminalItems
        .filter((item) => item.completedAt)
        .map((item) => ({
          id: item.id,
          at: Date.parse(item.completedAt!),
          agentName: item.agentName,
          projectName: item.projectName,
          phrase:
            item.status === "succeeded"
              ? "finished a job"
              : `Job ${item.status}`
        }))
    ].sort((left, right) => right.at - left.at)[0] ?? null;

  useLayoutEffect(() => {
    const node = mapRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setMapWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [rooms.length]);

  useEffect(() => {
    if (!serverTime) {
      const frame = window.requestAnimationFrame(() => setAsOf(null));
      return () => window.cancelAnimationFrame(frame);
    }
    const serverMs = Date.parse(serverTime);
    const monotonicAnchor = performance.now();
    const update = () =>
      setAsOf(serverMs + performance.now() - monotonicAnchor);
    const frame = window.requestAnimationFrame(update);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [serverTime]);

  useEffect(() => {
    if (!focusJobId) return;
    const job = jobs.find((entry) => entry.publication.jobId === focusJobId);
    const past = historicalItems.find((entry) => entry.jobId === focusJobId);
    const target = job?.id ?? past?.id;
    if (target) {
      // The explicit focus target can arrive after the feed's current/history pages load.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelection((current) =>
        current?.kind === "job" && current.id === target
          ? current
          : { kind: "job", id: target }
      );
    }
  }, [focusJobId, historicalItems, jobs]);

  return (
    <div className="mx-auto max-w-[1400px] px-2 pb-16 pt-4">
      <style>{SQUARE_CSS}</style>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-4 rounded-2xl border border-border/80 bg-surface/40 px-5 py-4">
        <Metric value={String(working.length)} label="working Jobs" />
        <Metric value={String(count(["checking"]))} label="checking Jobs" />
        <Metric
          value={String(
            jobs.filter((job) => job.publication.status === "waiting").length
          )}
          label="waiting Jobs"
        />
        <Metric value={String(offline.length)} label="offline Jobs" />
        <Metric
          value={String(
            jobs.filter((job) => job.publication.status === "queued").length
          )}
          label="queued Jobs"
        />
        <p className="ml-auto self-center text-[11px] text-faint">
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"} across{" "}
          {rooms.length} {rooms.length === 1 ? "project" : "projects"}
        </p>
      </div>
      {latestEvent && asOf !== null && (
        <div
          key={latestEvent.id}
          className="mt-2 flex items-center gap-2 rounded-full border border-border bg-surface/30 px-3 py-1.5 text-xs text-subtle"
        >
          <SquareAvatar name={latestEvent.agentName} toneId={latestEvent.id} />
          <span>
            <span className="font-medium text-foreground">
              {latestEvent.agentName}
            </span>{" "}
            {latestEvent.phrase} · {latestEvent.projectName} ·{" "}
            {timeAgoLabel(new Date(latestEvent.at).toISOString(), asOf)}
          </span>
        </div>
      )}

      {!shouldShowPublicSquareMap({
        jobs,
        rooms,
        historicalItems,
        idleAgentCount: idleAgents.length
      }) ? (
        <div className="mt-5 rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-subtle">
          No shared work in {teamName} yet. Team-authorized Jobs will appear
          here when an owner shares them.
        </div>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <div
              ref={mapRef}
              className="relative"
              style={{ height: layout.height }}
            >
              {layout.rooms.map((room) => {
                const jobsHere = jobs.filter(
                  (job) => job.publication.projectId === room.project.id
                );
                const roomLatest = jobsHere
                  .map((job) => observedEvent(job, asOf))
                  .filter(
                    (event): event is NonNullable<typeof event> =>
                      event !== null
                  )
                  .sort((left, right) => right.at - left.at)[0];
                const selected = selectedRoom?.id === room.project.id;
                return (
                  <div
                    key={room.project.id}
                    className={`absolute rounded-2xl border bg-surface/20 transition-[opacity,border-color] duration-300 ${selected ? "border-accent" : "border-border"} ${selectedRoom && !selected ? "opacity-45" : ""}`}
                    style={{
                      left: room.x,
                      top: room.y,
                      width: room.width,
                      height: room.height,
                      ...ROOM_TEXTURE
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSelection(
                          selected
                            ? null
                            : { kind: "room", id: room.project.id }
                        )
                      }
                      aria-label={`Show ${room.project.name} jobs`}
                      className="flex h-16 w-full flex-col justify-center gap-1 rounded-t-2xl border-b border-border/60 px-3.5 text-left transition-colors hover:bg-surface-hover/40"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${teamTone(room.project.id).solid}`}
                        />
                        <span className="truncate">{room.project.name}</span>
                        <span className="ml-auto flex-shrink-0 text-xs font-normal text-subtle">
                          {jobsHere.length}{" "}
                          {jobsHere.length === 1 ? "job" : "jobs"}
                        </span>
                      </span>
                      <span className="truncate text-xs text-subtle">
                        {roomLatest && asOf !== null
                          ? `${roomLatest.agentName} ${roomLatest.phrase} · ${timeAgoLabel(new Date(roomLatest.at).toISOString(), asOf)}`
                          : jobsHere.length
                            ? `${jobsHere.length} active ${jobsHere.length === 1 ? "Job" : "Jobs"}`
                            : "No active Jobs"}
                      </span>
                    </button>
                    {room.labels.map((label) => (
                      <span
                        key={label.id}
                        className="absolute left-3.5 text-[10px] font-medium uppercase tracking-wider text-faint"
                        style={{ top: label.y }}
                      >
                        {label.label} · {label.count}
                      </span>
                    ))}
                  </div>
                );
              })}
              {jobs.map((job) => {
                const position = layout.positions.get(job.id);
                if (!position) return null;
                const selected = selectedJob?.id === job.id;
                const dimmed =
                  selectedRoom !== null &&
                  job.publication.projectId !== selectedRoom.id;
                const moving =
                  job.zone === "working" || job.zone === "checking";
                return (
                  <button
                    key={job.publication.id}
                    type="button"
                    onClick={() => setSelection({ kind: "job", id: job.id })}
                    title={`${job.publication.agentName} · ${job.publication.ownerName} · ${job.statusLabel}`}
                    aria-label={`${job.publication.agentName} Job, ${job.publication.ownerName}, ${job.statusLabel}`}
                    className="ps-move absolute h-10 w-8"
                    style={{
                      left: position.x,
                      top: position.y,
                      opacity: job.zone === "offline" ? 0.35 : dimmed ? 0.3 : 1
                    }}
                  >
                    <span
                      className={`relative block rounded-md ${moving ? "ps-bob" : ""} ${selected ? "ring-2 ring-accent ring-offset-2 ring-offset-background" : ""}`}
                    >
                      <SquareAvatar
                        name={job.publication.agentName}
                        toneId={job.publication.agentId}
                        size="md"
                      />
                      {job.zone === "checking" && (
                        <span className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success text-background ring-2 ring-background">
                          <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        </span>
                      )}
                      {job.publication.status === "waiting" && (
                        <span
                          className={`absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold ring-2 ring-background ${job.waitingOnViewer ? "bg-accent text-white" : "bg-warning text-background"}`}
                        >
                          !
                        </span>
                      )}
                      {job.zone === "offline" && (
                        <WifiOff className="absolute -right-1.5 -top-1.5 h-3.5 w-3.5 rounded-full bg-background p-0.5 text-muted" />
                      )}
                    </span>
                    <span
                      className={`absolute left-1/2 top-[35px] h-1.5 w-1.5 -translate-x-1/2 rounded-full ${teamTone(job.publication.ownerId).solid}`}
                    />
                  </button>
                );
              })}
              <div
                className="absolute left-0 right-0 rounded-2xl border border-border bg-surface/10"
                style={{ top: layout.idleTop, height: layout.idleHeight }}
              >
                <span className="absolute left-3.5 top-3.5 text-[10px] font-medium uppercase tracking-wider text-faint">
                  Idle Agents · {idleAgents.length}
                </span>
                {idleAgents.length === 0 && (
                  <span className="absolute left-3.5 top-9 text-xs text-subtle">
                    No explicitly available Agents without an active Job in this
                    Team.
                  </span>
                )}
              </div>
              {idleAgents.map((agent) => {
                const id = `${agent.ownerId}:${agent.agentId}`;
                const position = layout.positions.get(id);
                if (!position) return null;
                const selected =
                  selection?.kind === "idle" && selection.id === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSelection({ kind: "idle", id })}
                    title={`${agent.agentName} · ${agent.ownerName} · No active Job in this Team`}
                    aria-label={`${agent.agentName}, ${agent.ownerName}, No active Job in this Team`}
                    className="ps-move absolute h-10 w-8 opacity-55"
                    style={{ left: position.x, top: position.y }}
                  >
                    <span
                      className={`relative block rounded-md ${selected ? "ring-2 ring-accent ring-offset-2 ring-offset-background" : ""}`}
                    >
                      <SquareAvatar
                        name={agent.agentName}
                        toneId={agent.agentId}
                        size="md"
                      />
                    </span>
                    <span
                      className={`absolute left-1/2 top-[35px] h-1.5 w-1.5 -translate-x-1/2 rounded-full ${teamTone(agent.ownerId).solid}`}
                    />
                  </button>
                );
              })}
            </div>

            <section
              className="mt-4 rounded-2xl border border-border bg-surface/10 px-3.5 py-3"
              aria-label="Finished Jobs"
            >
              <div className="mb-2.5 flex items-center justify-between gap-2">
                <p className="text-[10px] font-medium uppercase tracking-wider text-faint">
                  Finished · {terminalItems.length}
                </p>
                {hasMore && (
                  <button
                    type="button"
                    disabled={loadingMore}
                    onClick={onLoadMore}
                    className="text-[11px] text-subtle hover:text-foreground disabled:opacity-50"
                  >
                    {loadingMore ? "Loading…" : "History"}
                  </button>
                )}
              </div>
              {finishedItems.length === 0 ? (
                <p className="text-xs text-subtle">
                  Terminal Jobs collect here.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {finishedItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelection({ kind: "job", id: item.id })}
                      title={`${item.agentName} · ${item.ownerName} · ${item.status}${item.ownerLeftTeam ? " · Owner left Team" : ""}`}
                      aria-label={`Show ${item.agentName} terminal Job, ${item.status}${item.ownerLeftTeam ? ", owner left Team" : ""}`}
                      className={`h-3 w-3 rounded-[3px] ring-offset-2 ring-offset-background hover:ring-2 hover:ring-accent ${teamTone(item.ownerId).solid}`}
                    />
                  ))}
                </div>
              )}
            </section>
            {frozenItems.length > 0 && (
              <section
                className="mt-3 rounded-2xl border border-border bg-surface/10 px-3.5 py-3"
                aria-label="Frozen history from former Team members"
              >
                <p className="mb-2.5 text-[10px] font-medium uppercase tracking-wider text-faint">
                  Owner left Team · frozen history
                </p>
                <div className="space-y-1">
                  {frozenItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelection({ kind: "job", id: item.id })}
                      className="flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-xs hover:bg-surface-hover/40"
                    >
                      <span
                        className={`h-2 w-2 flex-shrink-0 rounded-sm ${teamTone(item.ownerId).solid}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-foreground-secondary">
                        {item.agentName} · {item.projectName}
                      </span>
                      <span className="text-faint">{item.status}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-subtle">
              {[
                ...new Map(
                  jobs.map((job) => [
                    job.publication.ownerId,
                    job.publication.ownerName
                  ])
                ).entries()
              ].map(([id, name]) => (
                <span key={id} className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${teamTone(id).solid}`}
                  />
                  {name}
                </span>
              ))}
              <span>
                The dot under each avatar shows the Job owner. Click an avatar
                or Project room for details.
              </span>
            </div>
          </div>

          <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">
            {selection?.kind === "idle" && model.idleById.get(selection.id) ? (
              <IdlePanel
                agent={model.idleById.get(selection.id)!}
                onBack={() => setSelection(null)}
              />
            ) : selectedJob ? (
              <JobPanel
                job={selectedJob}
                viewerId={viewerId}
                asOf={asOf}
                onBack={() => setSelection(null)}
              >
                {renderPublication(selectedJob.publication)}
              </JobPanel>
            ) : focusedHistory ? (
              <HistoryPanel
                item={focusedHistory}
                onBack={() => setSelection(null)}
              >
                {renderPublication(focusedHistory)}
              </HistoryPanel>
            ) : selectedRoom ? (
              <RoomPanel
                items={jobs.filter(
                  (job) => job.publication.projectId === selectedRoom.id
                )}
                getVisibleBrief={getVisibleBrief}
                onBack={() => setSelection(null)}
                onPick={(id) => setSelection({ kind: "job", id })}
              >
                {renderProjectActions(selectedRoom)}
              </RoomPanel>
            ) : (
              <Highlights
                waitingOnYou={waitingOnYou}
                waitingOnOthers={waitingOnOthers}
                offline={offline}
                longRunning={longRunning}
                historicalItems={terminalItems}
                serverTime={asOf}
                onOpenInbox={onOpenInbox}
                onPick={(id) => setSelection({ kind: "job", id })}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-3xl font-medium tracking-tight text-foreground">
        {value}
      </p>
      <p className="mt-1 text-[11px] uppercase tracking-wide text-subtle">
        {label}
      </p>
    </div>
  );
}

function SquareAvatar({
  name,
  toneId,
  size = "sm"
}: {
  name: string;
  toneId: string;
  size?: "sm" | "md" | "lg";
}) {
  const classes =
    size === "lg"
      ? "h-12 w-12 text-sm rounded-lg"
      : size === "md"
        ? "h-8 w-8 text-[11px] rounded-md"
        : "h-5 w-5 text-[8px] rounded-md";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex flex-shrink-0 items-center justify-center border border-border font-semibold ${classes} ${teamTone(toneId).chip}`}
    >
      {initialsFor(name)}
    </span>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 text-xs text-muted hover:text-foreground"
    >
      <ArrowLeft className="h-3 w-3" /> Highlights
    </button>
  );
}

function PanelHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-1 mt-5 text-[11px] font-medium uppercase tracking-wider text-subtle">
      {children}
    </h3>
  );
}

function JobPanel({
  job,
  viewerId,
  asOf,
  onBack,
  children
}: {
  job: SquareJob;
  viewerId: string;
  asOf: number | null;
  onBack: () => void;
  children: ReactNode;
}) {
  const item = job.publication;
  const age =
    job.startedAt !== null && asOf !== null
      ? elapsedLabel(job.startedAt, asOf)
      : null;
  const activeStep =
    item.status === "succeeded"
      ? 4
      : job.zone === "checking"
        ? 2
        : item.startedAt
          ? 1
          : 0;
  return (
    <div className="space-y-3.5 rounded-xl border border-border bg-surface/30 p-4">
      <BackButton onClick={onBack} />
      <div className="flex items-center gap-3">
        <SquareAvatar name={item.agentName} toneId={item.agentId} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-foreground">
            {item.agentName}
          </p>
          <p className="flex items-center gap-1.5 truncate text-xs text-subtle">
            <span
              className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${teamTone(item.ownerId).solid}`}
            />
            {item.ownerName} · {item.projectName}
          </p>
        </div>
        {age && <span className="font-mono text-sm text-muted">{age}</span>}
      </div>
      <p className={`text-sm ${statusClass(job)}`}>
        {job.zone === "offline"
          ? `Offline · last seen ${item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "unknown"} · last known ${item.lastKnownStatus ?? "state unavailable"}`
          : job.waitingOn
            ? job.waitingOnViewer
              ? "Waiting on you"
              : `Waiting on ${job.waitingOn.name}`
            : job.statusLabel}
      </p>
      {item.startedAt && (
        <div className="space-y-1.5">
          <div className="flex gap-1">
            {["Started", "Working", "Checking", "Done"].map((step, index) => (
              <span
                key={step}
                className={`h-1 flex-1 rounded-full ${index < activeStep ? "bg-success/60" : index === activeStep && item.status !== "succeeded" ? (job.zone === "offline" ? "bg-faint" : job.zone === "waiting" ? "bg-warning" : "ps-now bg-success") : "bg-surface-hover"}`}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-faint">
            {["Started", "Working", "Checking", "Done"].map((step) => (
              <span key={step}>{step}</span>
            ))}
          </div>
        </div>
      )}
      {job.zone !== "offline" && job.zone !== "idle" && (
        <div className="text-xs text-subtle">
          Only {item.ownerId === viewerId ? "you" : item.ownerName} can steer or
          stop this Job.
        </div>
      )}
      {children}
    </div>
  );
}

function HistoryPanel({
  item,
  onBack,
  children
}: {
  item: PublicSquarePublication;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-3.5 rounded-xl border border-border bg-surface/30 p-4">
      <BackButton onClick={onBack} />
      <div>
        <h2 className="text-[15px] font-medium text-foreground">
          {item.agentName}
        </h2>
        <p className="mt-0.5 text-xs text-subtle">
          {item.projectName} · {item.ownerName}
        </p>
        {item.ownerLeftTeam && (
          <p className="mt-1 text-xs text-warning">
            Owner left Team · frozen history
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function IdlePanel({
  agent,
  onBack
}: {
  agent: {
    agentId: string;
    agentName: string;
    ownerId: string;
    ownerName: string;
  };
  onBack: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface/30 p-4">
      <BackButton onClick={onBack} />
      <div className="flex items-center gap-3">
        <SquareAvatar name={agent.agentName} toneId={agent.agentId} size="lg" />
        <div>
          <h2 className="text-[15px] font-medium text-foreground">
            {agent.agentName}
          </h2>
          <p className="mt-0.5 text-xs text-subtle">{agent.ownerName}</p>
        </div>
      </div>
      <p className="text-sm text-muted">No active Job in this Team</p>
    </div>
  );
}

function RoomPanel({
  items,
  getVisibleBrief,
  onBack,
  onPick,
  children
}: {
  items: SquareJob[];
  getVisibleBrief: (item: PublicSquarePublication) => string | null;
  onBack: () => void;
  onPick: (id: string) => void;
  children: ReactNode;
}) {
  const countZone = (zone: SquareZone) =>
    items.filter((job) => job.zone === zone).length;
  return (
    <div className="rounded-xl border border-border bg-surface/30 p-4">
      <BackButton onClick={onBack} />
      <div className="mt-3">
        {children}
        <span className="mt-0.5 block text-xs text-subtle">
          {countZone("working")} working · {countZone("checking")} checking ·{" "}
          {items.filter((job) => job.publication.status === "waiting").length}{" "}
          waiting · {countZone("offline")} offline ·{" "}
          {items.filter((job) => job.publication.status === "queued").length}{" "}
          queued
        </span>
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-subtle">
          No Jobs are active in this Project.
        </p>
      ) : (
        <div className="mt-2">
          {items.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onPick(job.id)}
              className="flex w-full items-start gap-2.5 border-t border-border/60 py-2.5 text-left first:border-t-0 hover:bg-surface-hover/30"
            >
              <SquareAvatar
                name={job.publication.agentName}
                toneId={job.publication.agentId}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm">
                  <span className="font-medium text-foreground">
                    {job.publication.agentName}
                  </span>
                  <span className="text-subtle">
                    · {job.publication.ownerName}
                  </span>
                  <span
                    className={`ml-auto flex-shrink-0 text-xs ${statusClass(job)}`}
                  >
                    {job.statusLabel}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-subtle">
                  {getVisibleBrief(job.publication) ?? "Details not shared"}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Highlights({
  waitingOnYou,
  waitingOnOthers,
  offline,
  longRunning,
  historicalItems,
  serverTime,
  onOpenInbox,
  onPick
}: {
  waitingOnYou: SquareJob[];
  waitingOnOthers: Map<string, { name: string; count: number }>;
  offline: SquareJob[];
  longRunning: SquareJob[];
  historicalItems: PublicSquarePublication[];
  serverTime: number | null;
  onOpenInbox?: () => void;
  onPick: (id: string) => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface/30 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-foreground">Highlights</h2>
        <span className="text-xs text-subtle">worth a look</span>
      </div>
      <p className="mt-1 text-xs text-subtle">
        Routine steps stay on the map. This list only picks up Jobs that may
        need attention.
      </p>
      <PanelHeading>Needs a person</PanelHeading>
      {waitingOnYou.length === 0 &&
      waitingOnOthers.size === 0 &&
      offline.length === 0 ? (
        <p className="py-1.5 text-sm text-subtle">
          Nobody is blocked right now.
        </p>
      ) : (
        <div className="space-y-0.5">
          {waitingOnYou.length > 0 && (
            <div className="flex items-center gap-2.5 py-1.5 text-sm">
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-accent" />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {waitingOnYou.length === 1
                  ? `${waitingOnYou[0]!.publication.agentName} needs you`
                  : `${waitingOnYou.length} Jobs need you`}
              </span>
              {onOpenInbox && (
                <button
                  type="button"
                  onClick={onOpenInbox}
                  className="flex flex-shrink-0 items-center gap-1 rounded-md bg-chip px-2 py-1 text-xs font-medium text-chip-foreground hover:bg-chip-hover"
                >
                  Answer <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
          {[...waitingOnOthers.entries()].map(([userId, person]) => (
            <div
              key={userId}
              className="flex items-center gap-2.5 py-1.5 text-sm"
            >
              <span className="h-2 w-2 flex-shrink-0 rounded-full bg-warning" />
              <span className="text-foreground-secondary">
                {person.count} {person.count === 1 ? "Job is" : "Jobs are"}{" "}
                waiting on {person.name}
              </span>
            </div>
          ))}
          {offline.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onPick(job.id)}
              className="flex w-full items-center gap-2.5 py-1.5 text-left text-sm"
            >
              <WifiOff className="h-3.5 w-3.5 flex-shrink-0 text-subtle" />
              <span className="text-foreground-secondary">
                {job.publication.agentName} ({job.publication.ownerName}) is
                offline
              </span>
            </button>
          ))}
        </div>
      )}
      <PanelHeading>Just ended</PanelHeading>
      {historicalItems.length === 0 ? (
        <p className="py-1.5 text-sm text-subtle">Nothing ended yet.</p>
      ) : (
        <div className="space-y-1">
          {historicalItems.slice(0, 3).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onPick(item.id)}
              className="flex w-full items-start gap-2.5 rounded-md py-1.5 text-left hover:bg-surface-hover/40"
            >
              <SquareAvatar name={item.agentName} toneId={item.agentId} />
              <span className="min-w-0">
                <span className="block text-sm text-foreground">
                  {item.status === "succeeded"
                    ? "Job finished"
                    : `Job ${item.status}`}
                </span>
                <span className="block text-xs text-subtle">
                  {item.agentName} · {item.ownerName} · {item.projectName}
                  {item.completedAt && serverTime
                    ? ` · ${timeAgoLabel(item.completedAt, serverTime)}`
                    : ""}
                  {item.ownerLeftTeam ? " · Owner left Team" : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {longRunning.length > 0 && (
        <>
          <PanelHeading>Running long</PanelHeading>
          {longRunning.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => onPick(job.id)}
              className="flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-sm hover:bg-surface-hover/40"
            >
              <SquareAvatar
                name={job.publication.agentName}
                toneId={job.publication.agentId}
              />
              <span className="min-w-0 flex-1 truncate text-foreground-secondary">
                {job.publication.agentName}{" "}
                <span className="text-subtle">
                  · {job.publication.ownerName} · {job.publication.projectName}
                </span>
              </span>
              {job.startedAt !== null && serverTime !== null && (
                <span className="flex-shrink-0 font-mono text-xs text-warning">
                  {elapsedLabel(job.startedAt, serverTime)}
                </span>
              )}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
