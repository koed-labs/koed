import { SharingRuleContentPolicyReview } from "./SharingRuleContentPolicyReview.js";
import { SharingRulePublisherReview } from "./SharingRulePublisherReview.js";
import { SharingRuleDetailReview } from "./SharingRuleDetailReview.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OwnedRepositorySharingRule,
  SharingRuleDelivery
} from "@koed/shared";
import { canonicalJsonDigest as crossIdentitySyncDigest } from "@koed/shared/collaboration";
import type { CollaborationRendererClient } from "../../collaboration/renderer-client.js";
import { SharingRuleDeliveryStatus } from "./SharingRuleDeliveryStatus.js";
import { failureMessage } from "./collaboration-primitives.js";

export type RepositorySharingRulesClient = Pick<
  CollaborationRendererClient,
  | "listRepositoryRules"
  | "controlRepositoryRule"
  | "listSharingRuleDeliveries"
  | "reviewRuleDetail"
  | "amendRuleDetail"
  | "reviewRuleContentPolicy"
  | "amendRuleContentPolicy"
  | "reviewPublisherTakeover"
  | "takeOverPublisher"
  | "reviewGitAnchorSharing"
>;
export function RepositorySharingRules({
  client,
  selector,
  target: selectionTarget,
  creation
}: {
  client: RepositorySharingRulesClient;
  selector?: Parameters<
    RepositorySharingRulesClient["listRepositoryRules"]
  >[0]["selector"];
  target?: Parameters<
    RepositorySharingRulesClient["listRepositoryRules"]
  >[0]["target"];
  creation: SharingRuleDelivery | null;
}) {
  const [rules, setRules] = useState<OwnedRepositorySharingRule[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState("");
  const [deliveries, setDeliveries] = useState<SharingRuleDelivery[]>([]);
  const targetEpoch = useRef(0),
    queryEpoch = useRef(0);
  const load = useCallback(
    async (after: string | null) => {
      const target = targetEpoch.current,
        query = ++queryEpoch.current;
      setLoading(true);
      setError("");
      try {
        const page = await client.listRepositoryRules({
          ...(selector ? { selector } : {}),
          ...(selectionTarget ? { target: selectionTarget } : {}),
          afterRuleId: after,
          limit: 50
        });
        if (target !== targetEpoch.current || query !== queryEpoch.current)
          return;
        if (page.nextCursor && page.nextCursor === after)
          throw new Error("The rule list could not advance. Refresh sharing.");
        setRules((previous) =>
          after
            ? [
                ...previous.filter(
                  (rule) =>
                    !page.rules.some((next) => next.ruleId === rule.ruleId)
                ),
                ...page.rules
              ]
            : page.rules
        );
        setCursor(page.nextCursor);
      } catch (cause) {
        if (target === targetEpoch.current && query === queryEpoch.current)
          setError(
            failureMessage(
              cause,
              "Sharing rules are unavailable. Refresh sharing."
            )
          );
      } finally {
        if (target === targetEpoch.current && query === queryEpoch.current)
          setLoading(false);
      }
    },
    [client, selector, selectionTarget]
  );
  useEffect(() => {
    targetEpoch.current++;
    setRules([]);
    setCursor(null);
    setDeliveries([]);
    setBusy(null);
    void load(null);
    return () => {
      targetEpoch.current++;
      queryEpoch.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!creation || !("includesFutureConversations" in creation.intent))
      return;
    const createdSelector = creation.intent.selector;
    const sameLocalTarget =
      selectionTarget &&
      crossIdentitySyncDigest(creation.intent.review.target) ===
        crossIdentitySyncDigest(selectionTarget);
    if (
      selector &&
      !sameLocalTarget &&
      (createdSelector.kind !== selector.kind ||
        createdSelector.key !== selector.key ||
        (createdSelector.kind === "device_local_repository" &&
          selector.kind === "device_local_repository" &&
          createdSelector.originatingDeviceId !== selector.originatingDeviceId))
    )
      return;
    setDeliveries((previous) => [
      creation,
      ...previous.filter(
        (entry) => entry.intent.mutationId !== creation.intent.mutationId
      )
    ]);
    if (creation.state === "acknowledged") void load(null);
  }, [creation, load, selector, selectionTarget]);
  useEffect(() => {
    const pending = deliveries.filter(
      (delivery) => delivery.state === "queued"
    );
    if (!pending.length) return;
    const target = targetEpoch.current;
    const timer = setTimeout(() => {
      void (async () => {
        const updates: SharingRuleDelivery[] = [];
        for (const delivery of pending.slice(0, 100)) {
          try {
            const found = await client.listSharingRuleDeliveries({
              mutationId: delivery.intent.mutationId
            });
            const current = found.find(
              (entry) =>
                entry.intent.mutationId === delivery.intent.mutationId &&
                "ruleId" in entry.intent &&
                "ruleId" in delivery.intent &&
                entry.intent.ruleId === delivery.intent.ruleId
            );
            if (current) updates.push(current);
          } catch {
            /* Keep the visible request pending while its outcome is unknown. */
          }
        }
        if (target !== targetEpoch.current) return;
        setDeliveries((previous) =>
          previous.map(
            (entry) =>
              updates.find(
                (update) => update.intent.mutationId === entry.intent.mutationId
              ) ?? entry
          )
        );
        if (updates.some((entry) => entry.state !== "queued")) await load(null);
      })();
    }, 2000);
    return () => clearTimeout(timer);
  }, [client, deliveries, load]);
  const control = async (
    rule: OwnedRepositorySharingRule,
    controlAction: "pause" | "resume" | "stop" | "retry"
  ) => {
    const target = targetEpoch.current;
    setBusy(rule.ruleId);
    setError("");
    try {
      const delivery = await client.controlRepositoryRule({
        selectorKind: "selection",
        mutationId: crypto.randomUUID(),
        ruleId: rule.ruleId,
        teamId: rule.team.id,
        workspaceId: rule.workspace.id,
        expectedAuthorityVersion: rule.authorityVersion,
        publisherFence: rule.publisherFence,
        controlAction
      });
      if (target !== targetEpoch.current) return;
      setDeliveries((previous) => [
        delivery,
        ...previous.filter(
          (entry) => entry.intent.mutationId !== delivery.intent.mutationId
        )
      ]);
      if (delivery.state === "acknowledged") await load(null);
    } catch (cause) {
      if (target === targetEpoch.current)
        setError(
          failureMessage(
            cause,
            "The rule changed or this action is unavailable. Refresh sharing and review it again."
          )
        );
    } finally {
      if (target === targetEpoch.current) setBusy(null);
    }
  };
  const recordDelivery = (delivery: SharingRuleDelivery) => {
    setDeliveries((previous) => [
      delivery,
      ...previous.filter(
        (entry) => entry.intent.mutationId !== delivery.intent.mutationId
      )
    ]);
    if (delivery.state === "acknowledged") void load(null);
  };
  return (
    <section
      className="collab-selection-sharing-rules"
      aria-label={
        selector
          ? `${selector.kind === "folder" ? "Folder" : selector.kind === "project" ? "Project" : "Git Anchor"} sharing rules`
          : "Continuous sharing rules"
      }
    >
      <h3>
        {selector
          ? `Sharing rules for this ${selector.kind === "folder" ? "Folder" : selector.kind === "project" ? "Project" : "Git Anchor"}`
          : "Continuous sharing rules"}
      </h3>
      {error ? (
        <p role="alert" className="collab-form-error">
          {error}
        </p>
      ) : null}
      {loading ? <p role="status">Loading sharing rules…</p> : null}
      {!loading && !rules.length && !error ? (
        <p>No continuous sharing rules.</p>
      ) : null}
      {rules.map((rule) => {
        const pending = deliveries.some(
          (delivery) =>
            delivery.state === "queued" &&
            "ruleId" in delivery.intent &&
            delivery.intent.ruleId === rule.ruleId
        );
        const disabled = busy !== null || pending;
        return (
          <article key={rule.ruleId}>
            {!selector ? (
              <p>
                {rule.selector.kind === "folder"
                  ? "Folder"
                  : rule.selector.kind === "project"
                    ? "Project"
                    : "Git Anchor"}
              </p>
            ) : null}
            <strong>
              {rule.team.name} · {rule.workspace.name}
            </strong>
            <p>
              {rule.state === "active"
                ? "Active"
                : rule.state === "paused"
                  ? "Paused"
                  : "Stopped"}{" "}
              ·{" "}
              {rule.maximumFidelity === "memory_events"
                ? "Memory Events"
                : rule.maximumFidelity === "lcm_leaves"
                  ? "LCM Leaves"
                  : "LCM Rollups"}
              {rule.includeCuratedMemory ? " and Curated Memory" : ""}
            </p>
            {rule.state === "active" ? (
              <p>
                Existing and future eligible Conversations appear after their
                selected Memory detail is ready and passes Privacy processing.
              </p>
            ) : rule.state === "paused" ? (
              <p>
                Published Memory remains available. New members and revisions
                wait. Sources that stop matching lose this rule’s access.
              </p>
            ) : (
              <p>
                This rule supplies no Team access and admits no future
                Conversations.
              </p>
            )}
            {rule.publisher ? (
              <p>Publisher: {rule.publisher.label ?? "Unnamed device"}</p>
            ) : null}
            {!rule.publisherAvailable && rule.state !== "stopped" ? (
              <p>
                The recorded publisher is unavailable. You can still pause or
                stop this rule.
              </p>
            ) : null}
            {selectionTarget && rule.state !== "stopped" ? (
              <SharingRulePublisherReview
                client={client}
                ruleId={rule.ruleId}
                teamId={rule.team.id}
                workspaceId={rule.workspace.id}
                authorityVersion={rule.authorityVersion}
                publisherFence={rule.publisherFence}
                maximumFidelity={rule.maximumFidelity}
                target={selectionTarget}
                disabled={disabled}
                onDelivery={recordDelivery}
              />
            ) : null}
            <SharingRuleDetailReview
              key={rule.authorityVersion}
              client={client}
              ruleId={rule.ruleId}
              teamId={rule.team.id}
              workspaceId={rule.workspace.id}
              maximumFidelity={rule.maximumFidelity}
              includeCuratedMemory={rule.includeCuratedMemory}
              disabled={disabled}
              onDelivery={recordDelivery}
            />
            <SharingRuleContentPolicyReview
              key={`${rule.ruleId}:content:${rule.authorityVersion}`}
              client={client}
              ruleId={rule.ruleId}
              teamId={rule.team.id}
              workspaceId={rule.workspace.id}
              authorityVersion={rule.authorityVersion}
              disabled={disabled}
              onDelivery={recordDelivery}
            />
            {rule.state === "active" ? (
              <>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void control(rule, "pause")}
                >
                  Pause updates
                </button>
                <button
                  type="button"
                  disabled={disabled || !rule.publisherAvailable}
                  onClick={() => void control(rule, "retry")}
                >
                  Retry catch-up
                </button>
              </>
            ) : rule.state === "paused" ? (
              <button
                type="button"
                disabled={disabled || !rule.publisherAvailable}
                onClick={() => void control(rule, "resume")}
              >
                Resume updates
              </button>
            ) : null}
            {rule.state !== "stopped" ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void control(rule, "stop")}
              >
                Stop rule
              </button>
            ) : null}
          </article>
        );
      })}
      <SharingRuleDeliveryStatus
        deliveries={deliveries}
        onRefresh={() => void load(null)}
      />
      <button
        type="button"
        className="secondary"
        disabled={loading || busy !== null}
        onClick={() => void load(null)}
      >
        Refresh sharing rules
      </button>
      {cursor ? (
        <button
          type="button"
          disabled={loading || busy !== null}
          onClick={() => void load(cursor)}
        >
          Load more sharing rules
        </button>
      ) : null}
    </section>
  );
}
