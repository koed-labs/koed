import {
  publicSquareIsCurrent,
  type PublicSquarePublication
  // @ts-expect-error -- Node's native TypeScript runner needs the source extension.
} from "./public-square.ts";

export type SquareZone =
  | "working"
  | "checking"
  | "waiting"
  | "offline"
  | "idle";

export type SquareJob = {
  publication: PublicSquarePublication;
  id: string;
  zone: SquareZone;
  statusLabel: string;
  waitingOn: { userId: string; name: string } | null;
  waitingOnViewer: boolean;
  startedAt: number | null;
};

export type SquareProject = { id: string; name: string };

export function shouldShowPublicSquareMap(input: {
  jobs: SquareJob[];
  rooms: SquareProject[];
  historicalItems: PublicSquarePublication[];
  idleAgentCount: number;
}) {
  return (
    input.jobs.length > 0 ||
    input.rooms.length > 0 ||
    input.historicalItems.length > 0 ||
    input.idleAgentCount > 0
  );
}

export function groupWaitingJobsByUser(jobs: SquareJob[], viewerId: string) {
  const groups = new Map<string, { name: string; count: number }>();
  for (const job of jobs) {
    const person = job.waitingOn;
    if (
      job.publication.status !== "waiting" ||
      !person ||
      person.userId === viewerId
    )
      continue;
    const group = groups.get(person.userId);
    groups.set(person.userId, {
      name: person.name,
      count: (group?.count ?? 0) + 1
    });
  }
  return groups;
}

export function toSquareJob(
  item: PublicSquarePublication,
  viewerId: string
): SquareJob {
  const phase = "phase" in item ? item.phase : null;
  const zone: SquareZone =
    item.status === "offline"
      ? "offline"
      : item.status === "waiting" || item.status === "queued"
        ? "waiting"
        : item.status === "running"
          ? phase === "checking"
            ? "checking"
            : "working"
          : "idle";
  const statusLabel =
    item.status === "offline"
      ? "Offline"
      : item.status === "queued"
        ? "Queued"
        : item.status === "running"
          ? zone === "checking"
            ? "Checking"
            : "Working"
          : item.status === "waiting"
            ? "Waiting"
            : item.status === "succeeded"
              ? "Finished"
              : item.status[0]!.toUpperCase() + item.status.slice(1);
  return {
    publication: item,
    id: item.id,
    zone,
    statusLabel,
    waitingOn: item.status === "waiting" ? item.waitingOn : null,
    waitingOnViewer:
      item.status === "waiting" && item.waitingOn?.userId === viewerId,
    startedAt: item.startedAt ? Date.parse(item.startedAt) : null
  };
}

export function buildPublicSquareModel(input: {
  items: PublicSquarePublication[];
  projects: SquareProject[];
  viewerId: string;
}) {
  const currentItems = input.items.filter(publicSquareIsCurrent);
  const historicalItems = input.items.filter(
    (item) => !currentItems.includes(item)
  );
  const jobs = currentItems.map((item) => toSquareJob(item, input.viewerId));
  const projects = new Map(
    input.projects.map((project) => [project.id, project])
  );
  for (const item of currentItems) {
    if (!projects.has(item.projectId))
      projects.set(item.projectId, {
        id: item.projectId,
        name: item.projectName
      });
  }
  const rooms = [...projects.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  return {
    jobs,
    rooms,
    historicalItems: [...historicalItems].sort(
      (left, right) =>
        (right.completedAt ? Date.parse(right.completedAt) : 0) -
        (left.completedAt ? Date.parse(left.completedAt) : 0)
    ),
    counts: {
      working: jobs.filter(
        (job) => job.publication.status === "running" && job.zone === "working"
      ).length,
      checking: jobs.filter((job) => job.zone === "checking").length,
      waiting: jobs.filter((job) => job.publication.status === "waiting")
        .length,
      offline: jobs.filter((job) => job.zone === "offline").length,
      queued: jobs.filter((job) => job.publication.status === "queued").length,
      idle: jobs.filter((job) => job.zone === "idle").length
    }
  };
}
