import { readFile, writeFile } from "node:fs/promises";
import { asyncRecallCases } from "./cases.js";
import { scoreRecallTrace, type RecallEvent } from "./benchmark.js";

/** Reference traces exercise the evaluator; they are not model observations. */
export function referenceTrace(caseId: string): RecallEvent[] {
  const fixture = asyncRecallCases.find((entry) => entry.id === caseId);
  if (!fixture) throw new Error(`Unknown case: ${caseId}`);
  const events: RecallEvent[] = [];
  let time = 0;
  for (const [index, phase] of fixture.phases.entries()) {
    const taskId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const base = { phase: phase.phase, taskId };
    events.push({
      ...base,
      kind: "submitted",
      mode: phase.preferredMode,
      query: phase.phase,
      atMs: time
    });
    if (phase.preferredMode === "non_blocking") {
      events.push({ ...base, kind: "receipt", atMs: ++time });
      if (fixture.independentWork)
        events.push({ kind: "independent_action", atMs: ++time });
    }
    time += 5_000;
    events.push({ ...base, kind: "completed", atMs: time });
    events.push({
      ...base,
      kind: "collected",
      atMs: ++time,
      outcome: phase.memory ? "found" : "not_found"
    });
    events.push({
      phase: phase.phase,
      kind: "dependent_action",
      atMs: ++time,
      decision: phase.expected
    });
  }
  return events;
}

export async function main(args: string[]): Promise<void> {
  const option = (name: string) => args[args.indexOf(name) + 1];
  const tracePath = args.includes("--trace") ? option("--trace") : undefined;
  const caseId = args.includes("--case") ? option("--case") : undefined;
  if (tracePath && !caseId) throw new Error("--trace requires --case");
  const selected = asyncRecallCases.filter(
    (entry) => !caseId || entry.id === caseId
  );
  if (!selected.length) throw new Error("Unknown case");
  const observed = tracePath
    ? (JSON.parse(await readFile(tracePath, "utf8")) as RecallEvent[])
    : null;
  if (observed && !Array.isArray(observed))
    throw new Error("Trace must be an event array");
  const runs = selected.map((fixture) => {
    const events = observed ?? referenceTrace(fixture.id);
    return { events, ...scoreRecallTrace(fixture, events) };
  });
  const report = JSON.stringify(
    {
      version: "koed-async-recall-eval-v1",
      provenance: observed
        ? "external_trace_unverified"
        : "scripted_reference_not_model_behavior",
      advisoryPolicy: {
        maxPendingPolls: 2,
        tightPollIntervalMs: 1_000,
        maxTightPolls: 1
      },
      runs
    },
    null,
    2
  );
  if (args.includes("--out"))
    await writeFile(option("--out")!, `${report}\n`, { flag: "wx" });
  else console.log(report);
  if (runs.some((run) => !run.passed)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("/async-recall/index.js"))
  await main(process.argv.slice(2));
