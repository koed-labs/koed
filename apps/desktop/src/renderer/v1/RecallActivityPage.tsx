import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@koed-labs/ui";
import { Filter, Info, RefreshCw, Search, X } from "lucide-react";
import type {
  PersonalDesktopApi,
  RecallActivityListInput
} from "@koed-labs/shared/personal-desktop";
import type { MarkdownPlatformAdapters } from "../markdown/SecureMarkdown.js";
import type { DesktopProject } from "../../project-memory-ui.js";
import { Pixelkin } from "./pixelkin/Pixelkin.js";
import type { AgentLook } from "./pixelkin/agent-kin.js";
import { useRecallActivity } from "./use-recall-activity.js";
import { RecallActivityDetail } from "./RecallActivityDetail.js";
import {
  RecallActivityFilters,
  RecallSelect
} from "./RecallActivityFilters.js";
import {
  RecallActivitySummary,
  RecallActivityCoverage
} from "./RecallActivitySummary.js";
import { RecallActivityChart } from "./RecallActivityChart.js";
import { RecallActivityTable } from "./RecallActivityTable.js";
import {
  recallDateRange,
  recallPresetDates,
  type RecallRange
} from "./recall-activity-model.js";
import "./recall-activity.css";

const defaultFilters = (): RecallActivityListInput => {
  const dates = recallPresetDates("7");
  return { ...recallDateRange(dates.from, dates.to), limit: 50 };
};
const noProjects: readonly DesktopProject[] = [];

export function RecallActivityPage({
  api,
  adapters,
  agent,
  projects = noProjects
}: {
  api: PersonalDesktopApi | null;
  adapters: MarkdownPlatformAdapters;
  agent?: { name: string; look: AgentLook };
  projects?: readonly DesktopProject[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const [range, setRange] = useState<RecallRange>("7");
  const [filters, setFilters] = useState(defaultFilters);
  const [cursors, setCursors] = useState<
    NonNullable<RecallActivityListInput["cursor"]>[]
  >([]);
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { page, overview, loading, error, overviewError, accessLost, refresh } =
    useRecallActivity(api, { ...filters, cursor: cursors.at(-1) }, timezone);
  useEffect(() => {
    if (
      accessLost ||
      (!loading &&
        page &&
        selectedId &&
        !page.questions.some((row) => row.id === selectedId))
    )
      setSelectedId(null);
  }, [accessLost, loading, page, selectedId]);
  const apply = (next: RecallActivityListInput) => {
    setSelectedId(null);
    setCursors([]);
    setFilters(next);
  };
  const reset = () => {
    apply(defaultFilters());
    setRange("7");
    setQuery("");
    setFiltersOpen(false);
  };
  const callerNames = [
    ...new Set([
      ...(page?.questions.flatMap((row) =>
        row.metadata?.caller?.name ? [row.metadata.caller.name] : []
      ) ?? []),
      ...(filters.callerName ? [filters.callerName] : [])
    ])
  ].sort();
  const rows = page?.questions ?? [];
  const matching = query.trim()
    ? rows.filter((row) =>
        row.query
          ?.toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      )
    : rows;
  const advancedCount = [
    filters.projectId,
    filters.searchDomain,
    filters.callerName,
    filters.memoryStatus ?? filters.status,
    filters.minDurationMs,
    filters.maxDurationMs
  ].filter((value) => value !== undefined).length;
  return (
    <section className="recall-page" aria-labelledby="recall-title">
      <header className="recall-page-heading">
        <div className="recall-heading-identity">
          <div className="recall-heading-kin" aria-hidden="true">
            <Pixelkin
              look={agent?.look}
              size={64}
              presentation="stage"
              expression="neutral"
            />
          </div>
          <div>
            <h1 id="recall-title">Recall activity</h1>
            <p>What your AI Clients asked. What your memory brought back.</p>
          </div>
        </div>
        <div className="recall-heading-actions">
          <RecallSelect
            label="Date range"
            value={range}
            options={[
              { value: "1", label: "Today" },
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "custom", label: "Custom range" }
            ]}
            onChange={(value) => {
              const next = value as RecallRange;
              setRange(next);
              if (next === "custom") {
                setFiltersOpen(true);
                return;
              }
              const dates = recallPresetDates(next);
              apply({ ...filters, ...recallDateRange(dates.from, dates.to) });
            }}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh activity"
            disabled={loading}
            onClick={refresh}
          >
            <RefreshCw className={loading ? "recall-spinning" : ""} />
          </Button>
        </div>
      </header>
      <div className="recall-toolbar">
        <div className="recall-search">
          <Search />
          <Input
            aria-label="Search questions on this page"
            placeholder="Search this page…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear question search"
              onClick={() => setQuery("")}
            >
              <X />
            </Button>
          )}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="recall-filter-toggle"
          aria-label="Filters"
          title={
            advancedCount ? `Filters (${advancedCount} active)` : "Filters"
          }
          aria-expanded={filtersOpen}
          aria-controls="recall-advanced-filters"
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <Filter />
          {advancedCount > 0 && (
            <span className="recall-filter-active" aria-hidden="true" />
          )}
        </Button>
      </div>
      {filtersOpen && (
        <RecallActivityFilters
          key={JSON.stringify(filters)}
          input={filters}
          rows={rows}
          projects={projects}
          callerNames={callerNames}
          onReset={reset}
          onApply={(next) => {
            if (next.from !== filters.from || next.to !== filters.to)
              setRange("custom");
            apply(next);
            setFiltersOpen(false);
          }}
        />
      )}
      {error && (
        <div className="recall-notice" role="alert">
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={refresh}
          >
            Retry
          </Button>
        </div>
      )}
      {overviewError && !error && (
        <p className="recall-notice" role="alert">
          Overview statistics are unavailable. Refresh to retry.
        </p>
      )}
      <RecallActivitySummary overview={overview} loading={loading} />
      <div className="recall-overview-body">
        <RecallActivityTable
          key={JSON.stringify(filters)}
          rows={matching}
          total={overview?.recordedQuestions ?? null}
          loadedCount={rows.length}
          loading={loading}
          unavailable={accessLost || Boolean(error && !page)}
          pageNumber={cursors.length + 1}
          hasOlder={Boolean(page?.nextCursor)}
          search={query.trim()}
          onSelect={(row, event) => {
            selectedButton.current = event.currentTarget;
            setSelectedId(row.id);
          }}
          onNewer={() => {
            setSelectedId(null);
            setCursors((value) => value.slice(0, -1));
          }}
          onOlder={() => {
            if (page?.nextCursor) {
              setSelectedId(null);
              setCursors((value) => [...value, page.nextCursor!]);
            }
          }}
          onReset={reset}
        />
        <RecallActivityChart
          overview={overview}
          from={filters.from}
          to={filters.to}
          loading={loading}
        />
      </div>
      <footer className="recall-page-footer">
        <span>
          {loading
            ? "Refreshing…"
            : page
              ? `Updated ${new Date(page.asOf).toLocaleTimeString()}`
              : "Awaiting activity"}
          {query.trim() && " · Search applies to this page only"}
        </span>
        <Button variant="ghost" size="sm" onClick={() => setCoverageOpen(true)}>
          <Info />
          About these metrics
        </Button>
      </footer>
      <RecallActivityCoverage
        overview={overview}
        open={coverageOpen}
        onOpenChange={setCoverageOpen}
      />
      {selectedId && api && (
        <RecallActivityDetail
          api={api}
          projects={projects}
          adapters={adapters}
          questionId={selectedId}
          revision={JSON.stringify(
            page?.questions.find((row) => row.id === selectedId) ?? null
          )}
          onClose={() => {
            setSelectedId(null);
            selectedButton.current?.focus();
          }}
        />
      )}
    </section>
  );
}
