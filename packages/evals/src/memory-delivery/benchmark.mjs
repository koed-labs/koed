export const deliveryScenarios = Object.freeze([
  "delayed",
  "fast",
  "not_found",
  "failed",
  "interrupted",
  "blocking",
  "fallback"
]);

export const claudeDeliveryScenarios = Object.freeze([
  "background_enabled",
  "background_disabled",
  "blocking_background",
  "fast",
  "not_found",
  "failed",
  "interrupted",
  "ambiguous"
]);

// Dependency rules shared by every single-recall host scorer.
const priorEvents = (events, e) => events.slice(0, events.indexOf(e));
const dependentActionsFollowFoundCompletion = (events) =>
  events
    .filter((e) => e.kind === "dependent_action")
    .every(
      (e) =>
        priorEvents(events, e).find((c) => c.kind === "completion")?.outcome ===
        "found"
    );
const fixedClaimsFollowDependentAction = (events) =>
  events
    .filter((e) => e.kind === "final_response" && e.status === "fixed")
    .every((e) =>
      priorEvents(events, e).some((c) => c.kind === "dependent_action")
    );
const appliesRecalledSettings = (expectedSettings, actualSettings) =>
  actualSettings?.retryDelayMs === expectedSettings.retryDelayMs &&
  actualSettings?.cacheAuthorization === expectedSettings.cacheAuthorization;

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
    noPrematureDependentAction: dependentActionsFollowFoundCompletion(events),
    noFalseCompletionClaim: fixedClaimsFollowDependentAction(events),
    expectedAction: shouldFix ? dependent.length === 1 : dependent.length === 0,
    usesRecalledConstraint:
      !shouldFix || appliesRecalledSettings(expectedSettings, actualSettings),
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

// Claude delivers through its host's background task notifications, so the
// host-specific checks differ while the dependency rules above stay shared.
export const scoreClaudeDeliveryRun = ({
  scenario,
  events,
  expectedSettings,
  actualSettings,
  exitCode,
  executions,
  interrupted,
  waiterDetached
}) => {
  if (!claudeDeliveryScenarios.includes(scenario))
    throw new Error("Unknown Claude delivery scenario");
  const index = (kind) => events.findIndex((e) => e.kind === kind);
  const enabled = scenario !== "background_disabled";
  const dependentFirst = ["blocking_background", "ambiguous"].includes(
    scenario
  );
  const shouldFix = !["failed", "not_found", "interrupted"].includes(scenario);
  const recalls = events.filter((e) => e.kind === "recall_requested");
  const checks = {
    oneExecution: executions === 1,
    oneRecall: recalls.length === 1,
    correctMode:
      recalls[0]?.mode === (dependentFirst ? "blocking" : "non_blocking"),
    noPrematureEdit: dependentActionsFollowFoundCompletion(events),
    expectedEdit:
      events.filter((e) => e.kind === "dependent_action").length ===
      (shouldFix ? 1 : 0),
    correctSettings:
      !shouldFix || appliesRecalledSettings(expectedSettings, actualSettings),
    hostEnded: scenario === "interrupted" ? interrupted : exitCode === 0
  };
  if (scenario !== "interrupted")
    checks.observedFinalStatus = events.some(
      (e) =>
        e.kind === "final_response" &&
        e.status === (shouldFix ? "fixed" : "blocked")
    );
  if (enabled && scenario !== "fast" && scenario !== "interrupted")
    checks.nativeBackgroundNotification =
      index("host_background_receipt") >= 0 &&
      index("host_notification") > index("host_background_receipt");
  if (!enabled)
    checks.backgroundDisabled =
      index("host_background_receipt") < 0 &&
      index("diagnostic_read") > index("completion");
  if (scenario === "background_enabled")
    checks.independentWorkBeforeCompletion =
      index("diagnostic_read") >= 0 &&
      index("diagnostic_read") < index("completion");
  if (dependentFirst)
    checks.noUnneededDiagnostic = index("diagnostic_read") < 0;
  checks.noPrematureCompletionClaim = fixedClaimsFollowDependentAction(events);
  if (enabled && shouldFix && scenario !== "fast")
    checks.notificationBeforeEdit =
      index("host_notification") >= 0 &&
      index("dependent_action") > index("host_notification");
  if (scenario === "interrupted")
    checks.waiterDetachesWithoutCancellation =
      waiterDetached && index("task_terminal") > index("waiter_detached");
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
  if (scenario === "concurrent") {
    // Both recalls must be pending together; sequential recall would pass
    // every check above without exercising concurrent delivery.
    const lastRecall = events.findLastIndex(
      (e) => e.kind === "recall_requested"
    );
    const firstResult = events.findIndex((e) =>
      ["task_terminal", "completion"].includes(e.kind)
    );
    checks.recallsOverlap =
      lastRecall >= 0 && (firstResult < 0 || lastRecall < firstResult);
  }
  return { passed: Object.values(checks).every(Boolean), checks };
};
