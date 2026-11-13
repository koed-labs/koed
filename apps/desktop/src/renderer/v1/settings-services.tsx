import { Badge, Button, Card } from "@koed-labs/ui";
import { Activity, Clipboard, FileText, RefreshCw } from "lucide-react";
import type { ComponentStatus, KoedServerStatus } from "../../types.js";
import { AccelerationSettings } from "./AccelerationSettings.js";
import {
  EmbeddingStateDetails,
  embeddingSummaryLabel,
  formatDuration
} from "../views/preferences/EmbeddingStateDetails.js";
import {
  Group,
  PageHeading,
  PageLink,
  Row,
  type Detail
} from "./settings-controls.js";

export function settingsServiceComponents(
  status: KoedServerStatus | null
): [string, ComponentStatus][] {
  if (!status) return [];
  return (
    [
      ["Server package", status.serverPackage],
      ["API", status.api],
      ["Database", status.database],
      ["Redis", status.redis],
      ["Worker queues", status.workerQueues],
      ["Embedding Service", status.embeddingService],
      ["Privacy Filter Service", status.privacyService],
      ["Local AI Runtime", status.localAiRuntime],
      ["Local runtime credential", status.apiToken],
      ["MCP Server", status.mcpServer],
      ["Capture Hook", status.captureHook],
      ["LCM Summary Service", status.lcmSummaryService],
      ["Personal Device Sync", status.personalDeviceSync]
    ] as const
  ).flatMap(([title, component]) => (component ? [[title, component]] : []));
}
function healthSummary(components: [string, ComponentStatus][]) {
  if (!components.length) return "Service status unavailable";
  const attention = components.filter(
    ([, component]) => component.state !== "healthy"
  ).length;
  return attention
    ? `${attention} ${attention === 1 ? "service needs" : "services need"} attention`
    : "All services are healthy";
}
export function SettingsServicesOverview({
  status,
  onOpen,
  embeddingSupported
}: {
  status: KoedServerStatus | null;
  embeddingSupported?: boolean;
  onOpen: (page: Detail) => void;
}) {
  const components = settingsServiceComponents(status);
  const healthy = components.filter(
    ([, component]) => component.state === "healthy"
  ).length;
  const embedding = status?.embeddingState;
  const hasEmbedding = embeddingSupported ?? embedding !== undefined;
  const pending = embedding?.backlog
    ? embedding.backlog.pendingMemoryEvents +
      embedding.backlog.pendingMemoryNodes
    : null;
  const estimate =
    pending && embedding?.drainEstimate
      ? `${formatDuration(embedding.drainEstimate.lowerSeconds)} – ${formatDuration(embedding.drainEstimate.upperSeconds)} left`
      : pending === 0 && embedding?.activity === "idle"
        ? "Up to date"
        : "Estimate unavailable";
  const metrics = [
    [
      "Healthy services",
      components.length ? healthy + " / " + components.length : "—",
      healthSummary(components)
    ]
  ];
  if (hasEmbedding)
    metrics.push(
      ["Pending embeddings", pending?.toLocaleString() ?? "—", estimate],
      [
        "Throughput",
        embedding?.throughput?.measuredTokensPerSecond.toLocaleString() ?? "—",
        "tokens / second"
      ]
    );
  return (
    <>
      <div className="metrics">
        {metrics.map(([label, value, detail]) => (
          <Card key={label} className="metric">
            <small>{label}</small>
            <strong>{value}</strong>
            <span>{detail}</span>
          </Card>
        ))}
      </div>
      <Group title="Service details">
        <PageLink
          page="health"
          onOpen={onOpen}
          note="Inspect individual services and attention messages."
        />
        {hasEmbedding && (
          <PageLink
            page="embedding"
            onOpen={onOpen}
            note={embeddingSummaryLabel(embedding ?? null)}
          />
        )}
        <PageLink page="performance" onOpen={onOpen} />
      </Group>
      <AccelerationSettings />
    </>
  );
}
export function SettingsServicePage({
  page,
  status,
  onBack
}: {
  page: "health" | "embedding";
  status: KoedServerStatus | null;
  onBack: () => void;
}) {
  const components = settingsServiceComponents(status);
  return (
    <>
      <PageHeading page={page} onBack={onBack} />
      {page === "health" ? (
        <Group title="Reported components">
          {components.length ? (
            components.map(([name, component]) => (
              <Row
                key={name}
                title={name}
                description={
                  component.state === "healthy" ? undefined : component.message
                }
              >
                <Badge variant="outline">
                  <i
                    className={
                      "status-dot" +
                      (component.state === "healthy" ? "" : " attention")
                    }
                  />
                  {component.state === "healthy"
                    ? "Healthy"
                    : component.state === "needs_attention"
                      ? "Needs attention"
                      : component.state.replaceAll("_", " ")}
                </Badge>
              </Row>
            ))
          ) : (
            <p className="pad" role="status">
              Service status unavailable. Refresh status to try again.
            </p>
          )}
        </Group>
      ) : status && status.embeddingState === undefined ? (
        <p role="status">Embedding status is not offered by this deployment.</p>
      ) : (
        <Card className="embedding">
          <EmbeddingStateDetails
            state={status?.embeddingState ?? null}
            presentation="page"
          />
        </Card>
      )}
    </>
  );
}
export type ServiceAction =
  | "start"
  | "restart"
  | "open_logs"
  | "diagnostics"
  | "doctor";
export function ServiceActions({
  running,
  busy,
  disabled,
  run
}: {
  running: boolean;
  busy: ServiceAction | null;
  disabled: boolean;
  run: (action: ServiceAction) => void;
}) {
  return (
    <Group title="Service actions">
      <Row
        title="Local services"
        description={
          running
            ? "Restart the services on this device."
            : "Start the services on this device."
        }
      >
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run(running ? "restart" : "start")}
        >
          {busy === "restart"
            ? "Restarting…"
            : busy === "start"
              ? "Starting…"
              : running
                ? "Restart Koed"
                : "Start Koed"}
        </Button>
      </Row>
      <div className="actions pad">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run("doctor")}
        >
          <Activity />
          {busy === "doctor" ? "Running diagnostics…" : "Run diagnostics"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run("open_logs")}
        >
          <FileText />
          {busy === "open_logs" ? "Opening…" : "Open logs"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run("diagnostics")}
        >
          <Clipboard />
          {busy === "diagnostics" ? "Copying…" : "Copy diagnostics"}
        </Button>
      </div>
    </Group>
  );
}
export function ServiceStatusFooter({
  disabled,
  notice,
  updatedAt,
  refresh
}: {
  disabled: boolean;
  notice: string | null;
  updatedAt?: string;
  refresh: () => void;
}) {
  return (
    <div className="service-footer">
      <span role="status">
        {notice ??
          (updatedAt
            ? "Updated " + new Date(updatedAt).toLocaleTimeString()
            : "")}
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Refresh status"
        disabled={disabled}
        onClick={refresh}
      >
        <RefreshCw />
        Refresh status
      </Button>
    </div>
  );
}
