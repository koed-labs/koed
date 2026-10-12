export const deliveryScenarios = Object.freeze([
  "delayed",
  "fast",
  "not_found",
  "failed",
  "interrupted",
  "blocking",
  "fallback"
]);

// Task readiness is distinct from completion presented to the model. A native
// Codex result can already be ready while delivery still awaits its Stop hook.
export const scoreDeliveryRun = ({
  scenario,
  events,
  expectedSettings,
  actualSettings,
  exitCode,
  host = "codex"
}) => {
  if (!deliveryScenarios.includes(scenario))
    throw new Error("Unknown delivery scenario");
  const ofKind = (kind) => events.filter((e) => e.kind === kind);
  const index = (kind) => events.findIndex((e) => e.kind === kind);
  const before = (a, b) => index(a) >= 0 && index(b) > index(a);
  const dependent = ofKind("dependent_action");
  const shouldFix = ["delayed", "fast", "blocking", "fallback"].includes(
    scenario
  );
  const shouldDefer = [
    "delayed",
    "fast",
    "not_found",
    "failed",
    "interrupted"
  ].includes(scenario);
  const expectedMode = scenario === "blocking" ? "blocking" : "non_blocking";
  const checks = {
    oneRecallInvocation: ofKind("recall_requested").length === 1,
    requestedMode: ofKind("recall_requested")[0]?.mode === expectedMode,
    noModelPolling: ofKind("model_poll").length === 0,
    noPrematureDependentAction: dependent.every((e) => {
      const completion = events
        .slice(0, events.indexOf(e))
        .find((c) => c.kind === "completion");
      return completion?.outcome === "found";
    }),
    noFalseCompletionClaim: ofKind("final_response").every(
      (e) =>
        e.status !== "fixed" ||
        events
          .slice(0, events.indexOf(e))
          .some((c) => c.kind === "dependent_action")
    ),
    expectedAction: shouldFix ? dependent.length === 1 : dependent.length === 0,
    usesRecalledConstraint:
      !shouldFix ||
      (actualSettings?.retryDelayMs === expectedSettings.retryDelayMs &&
        actualSettings?.cacheAuthorization ===
          expectedSettings.cacheAuthorization),
    terminalHostState:
      scenario === "interrupted"
        ? ofKind("interruption").length === 1
        : exitCode === 0,
    finalStatus:
      scenario === "interrupted" ||
      ofKind("final_response").at(-1)?.status ===
        (shouldFix ? "fixed" : "blocked")
  };
  if (shouldDefer) {
    checks.receipt = ofKind("receipt").length === 1;
    if (scenario !== "interrupted") {
      if (host === "codex" || scenario === "delayed")
        checks.yieldsForDelivery =
          before("receipt", "yield") && before("yield", "completion");
      checks.completionOutcome =
        ofKind("completion")[0]?.outcome ===
        (scenario === "not_found"
          ? "not_found"
          : scenario === "failed"
            ? "failed"
            : "found");
    }
  } else checks.noDeferredReceipt = ofKind("receipt").length === 0;
  if (scenario === "delayed")
    checks.independentWorkWhilePending =
      before("recall_requested", "diagnostic_read") &&
      before("diagnostic_read", "completion");
  if (scenario === "fast")
    checks.fastTaskReadiness = before("task_terminal", "diagnostic_read");
  if (scenario === "blocking")
    checks.directRecallHasNoDiagnostics =
      ofKind("diagnostic_read").length === 0;
  return { passed: Object.values(checks).every(Boolean), checks };
};

export const scoreAttributedDeliveryRun = ({
  scenario,
  events,
  expectedSettings,
  actualSettings
}) => {
  if (!["mixed", "concurrent"].includes(scenario))
    throw new Error("Unknown attributed delivery scenario");
  const targets = ["alpha", "beta"];
  const checks = {
    oneRecallPerTarget: targets.every(
      (target) =>
        events.filter(
          (e) => e.kind === "recall_requested" && e.target === target
        ).length === 1
    ),
    selectedModes: targets.every(
      (target) =>
        events.find((e) => e.kind === "recall_requested" && e.target === target)
          ?.mode ===
        (scenario === "mixed" && target === "alpha"
          ? "blocking"
          : "non_blocking")
    ),
    oneEditPerTarget: targets.every(
      (target) =>
        events.filter(
          (e) => e.kind === "dependent_action" && e.target === target
        ).length === 1
    ),
    completionBeforeEachEdit: events
      .filter((e) => e.kind === "dependent_action")
      .every((e) =>
        events
          .slice(0, events.indexOf(e))
          .some(
            (c) =>
              c.kind === "completion" &&
              c.target === e.target &&
              c.outcome === "found"
          )
      ),
    correctAttribution: targets.every(
      (target) =>
        actualSettings[target]?.retryDelayMs ===
          expectedSettings[target].retryDelayMs &&
        actualSettings[target]?.cacheAuthorization === false
    ),
    noPrematureCompletionClaim: events
      .filter((e) => e.kind === "final_response" && e.status === "fixed")
      .every((e) =>
        targets.every((target) =>
          events
            .slice(0, events.indexOf(e))
            .some((a) => a.kind === "dependent_action" && a.target === target)
        )
      ),
    finalStatus:
      events.filter((e) => e.kind === "final_response").at(-1)?.status ===
      "fixed"
  };
  return { passed: Object.values(checks).every(Boolean), checks };
};
