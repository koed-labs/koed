// Adapter-only policy, shipped unchanged with the standalone Pi integration.
// No presentation preference belongs in the execution request.
export const MEMORY_ANSWER_DELIVERY_MODES = Object.freeze([
  "auto",
  "blocking",
  "non_blocking"
]);

export const normalizeMemoryAnswerDeliveryMode = (value) => {
  if (value === undefined) return "auto";
  if (!MEMORY_ANSWER_DELIVERY_MODES.includes(value))
    throw new Error("Invalid Memory Answer delivery mode");
  return value;
};

export const splitMemoryAnswerDeliveryInput = (input) => {
  const requestedMode = normalizeMemoryAnswerDeliveryMode(input.delivery_mode);
  const executionInput = { ...input };
  delete executionInput.delivery_mode;
  return { requestedMode, executionInput };
};

export const resolveMemoryAnswerDelivery = ({
  requestedMode,
  blockingRoute,
  deferredRoute,
  unavailableReason
}) => ({
  requestedMode,
  effectiveRoute:
    requestedMode === "blocking" || unavailableReason || !deferredRoute
      ? blockingRoute
      : deferredRoute,
  fallbackReason:
    requestedMode === "blocking"
      ? null
      : (unavailableReason ?? (deferredRoute ? null : "deferred_unavailable"))
});
