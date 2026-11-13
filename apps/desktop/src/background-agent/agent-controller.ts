import type {
  BackgroundAgentState,
  BackgroundAgentStateStore
} from "./state.js";
import {
  BACKGROUND_AGENT_PROTOCOL_VERSION,
  type BackgroundAgentRequest,
  type BackgroundAgentResponse
} from "./protocol.js";

interface BackgroundAgentRuntimeManager {
  resume(): Promise<unknown>;
  stopRuntime(explicit: boolean): Promise<unknown>;
  handlers: {
    start_daemon(): unknown;
    status(): unknown;
  };
}

export interface BackgroundAgentController {
  startup(): Promise<BackgroundAgentState>;
  handle(request: BackgroundAgentRequest): Promise<BackgroundAgentResponse>;
  startExplicit(): Promise<BackgroundAgentState>;
  stopExplicit(): Promise<BackgroundAgentState>;
  close(): void;
}

export const createBackgroundAgentController = (input: {
  store: BackgroundAgentStateStore;
  manager: BackgroundAgentRuntimeManager;
  onError?: (error: unknown) => void;
}): BackgroundAgentController => {
  let startupPromise: Promise<BackgroundAgentState> | undefined;
  let closed = false;
  const reportError =
    input.onError ??
    ((error: unknown) =>
      console.error("Background Agent settlement failed:", error));

  const startup = () => {
    if (!startupPromise) startupPromise = startFromPersistedState();
    return startupPromise;
  };

  const startFromPersistedState = async (): Promise<BackgroundAgentState> => {
    const current = requireState(input.store.read());
    if (current.stopIntent || current.state === "needs_attention")
      return current;
    const starting =
      current.state === "stopped"
        ? input.store.start({
            expectedGeneration: current.generation,
            explicit: false
          })
        : input.store.recover();
    return settleGeneration(starting.generation);
  };

  const settleGeneration = async (
    expectedGeneration: number
  ): Promise<BackgroundAgentState> => {
    try {
      const result = await input.manager.resume();
      const current = requireState(input.store.read());
      if (current.generation !== expectedGeneration || current.stopIntent)
        return current;
      if (isRuntimeReady(result))
        return input.store.markReady(expectedGeneration);
      return input.store.markNeedsAttention(expectedGeneration);
    } catch {
      const current = requireState(input.store.read());
      if (current.generation !== expectedGeneration || current.stopIntent)
        return current;
      return input.store.markNeedsAttention(expectedGeneration);
    }
  };

  const settleStartedGeneration = async (generation: number) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const before = requireState(input.store.read());
      if (closed || before.generation !== generation || before.stopIntent)
        return before;
      try {
        const result = await input.manager.handlers.status();
        const current = requireState(input.store.read());
        if (closed || current.generation !== generation || current.stopIntent)
          return current;
        if (isRuntimeReady(result)) return input.store.markReady(generation);
        if (isRuntimeTerminal(result))
          return input.store.markNeedsAttention(generation);
      } catch {
        if (attempt === 59) return input.store.markNeedsAttention(generation);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return input.store.markNeedsAttention(generation);
  };

  const scheduleSettlement = (generation: number) => {
    void settleStartedGeneration(generation).catch(reportError);
  };

  const respond = (
    request: BackgroundAgentRequest,
    state: BackgroundAgentState,
    result: {
      ok?: boolean;
      errorCode?: BackgroundAgentResponse["errorCode"];
      message?: string;
    } = {}
  ): BackgroundAgentResponse => ({
    protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
    requestId: request.requestId,
    installationId: request.installationId,
    homeIdentity: request.homeIdentity,
    kind: request.kind,
    generation: state.generation,
    state: state.state,
    ok: result.ok ?? state.state !== "needs_attention",
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.message ? { message: result.message.slice(0, 512) } : {})
  });

  const readResponse = (request: BackgroundAgentRequest) => {
    const result = input.store.read();
    if (result.kind === "valid") return respond(request, result.state);
    const message =
      result.kind === "missing"
        ? "Background Agent state is not initialized."
        : "Background Agent state is invalid.";
    const generation =
      request.kind === "start" || request.kind === "stop"
        ? request.expectedGeneration
        : 0;
    const response: BackgroundAgentResponse = {
      protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
      requestId: request.requestId,
      installationId: request.installationId,
      homeIdentity: request.homeIdentity,
      kind: request.kind,
      generation,
      state: "needs_attention" as const,
      ok: false,
      errorCode: "not_ready" as const,
      message
    };
    return response;
  };

  const start = async (
    request: Extract<BackgroundAgentRequest, { kind: "start" }>
  ) => {
    const current = requireState(input.store.read());
    if (request.expectedGeneration !== current.generation)
      return staleGenerationResponse(request, current);
    try {
      const starting = input.store.start({
        expectedGeneration: request.expectedGeneration,
        explicit: request.explicit
      });
      if (starting.state === "ready") return respond(request, starting);
      const result = await input.manager.handlers.start_daemon();
      if (!isOperationSuccessful(result)) {
        const attention = input.store.markNeedsAttention(starting.generation);
        return respond(request, attention, {
          ok: false,
          errorCode: "start_failed",
          message: operationMessage(
            result,
            "Background Agent could not start Koed."
          )
        });
      }
      scheduleSettlement(starting.generation);
      return respond(request, starting, {
        message: "Background Agent is starting Koed."
      });
    } catch (error) {
      const latest = requireState(input.store.read());
      if (isStaleGenerationError(error))
        return staleGenerationResponse(request, latest);
      return respond(request, latest, {
        ok: false,
        errorCode: isStopIntentError(error) ? "not_authorized" : "start_failed",
        message: errorMessage(error, "Background Agent could not start Koed.")
      });
    }
  };

  const stop = async (
    request: Extract<BackgroundAgentRequest, { kind: "stop" }>
  ) => {
    const current = requireState(input.store.read());
    if (request.expectedGeneration !== current.generation)
      return staleGenerationResponse(request, current);
    let stopped: BackgroundAgentState;
    try {
      stopped = input.store.stop(request.expectedGeneration, request.explicit);
    } catch (error) {
      const latest = requireState(input.store.read());
      return isStaleGenerationError(error)
        ? staleGenerationResponse(request, latest)
        : respond(request, latest, {
            ok: false,
            errorCode: "stop_failed",
            message: errorMessage(
              error,
              "Background Agent could not stop Koed."
            )
          });
    }

    try {
      const result = await input.manager.stopRuntime(request.explicit);
      if (!isOperationSuccessful(result)) {
        const attention = request.explicit
          ? input.store.markStopNeedsAttention(stopped.generation)
          : input.store.markNeedsAttention(stopped.generation);
        return respond(request, attention, {
          ok: false,
          errorCode: "stop_failed",
          message: operationMessage(
            result,
            "Background Agent could not stop Koed."
          )
        });
      }
      return respond(request, stopped, { message: "Koed was stopped." });
    } catch (error) {
      const attention = request.explicit
        ? input.store.markStopNeedsAttention(stopped.generation)
        : input.store.markNeedsAttention(stopped.generation);
      return respond(request, attention, {
        ok: false,
        errorCode: "stop_failed",
        message: errorMessage(error, "Background Agent could not stop Koed.")
      });
    }
  };

  const startExplicit = async () => {
    if (closed) throw new Error("Background Agent controller is closed.");
    const current = requireState(input.store.read());
    const starting = input.store.start({
      expectedGeneration: current.generation,
      explicit: true
    });
    if (starting.state === "ready") return starting;
    const result = await input.manager.handlers.start_daemon();
    if (!isOperationSuccessful(result))
      return input.store.markNeedsAttention(starting.generation);
    scheduleSettlement(starting.generation);
    return starting;
  };

  const stopExplicit = async () => {
    if (closed) throw new Error("Background Agent controller is closed.");
    const current = requireState(input.store.read());
    const stopped = input.store.stop(current.generation, true);
    try {
      const result = await input.manager.stopRuntime(true);
      if (!isOperationSuccessful(result))
        return input.store.markStopNeedsAttention(stopped.generation);
      return stopped;
    } catch (error) {
      reportError(error);
      return input.store.markStopNeedsAttention(stopped.generation);
    }
  };

  const handle = async (
    request: BackgroundAgentRequest
  ): Promise<BackgroundAgentResponse> => {
    if (closed) throw new Error("Background Agent controller is closed.");
    void startup().catch(reportError);
    if (request.kind === "start") return start(request);
    if (request.kind === "stop") return stop(request);
    return readResponse(request);
  };

  return {
    startup,
    handle,
    startExplicit,
    stopExplicit,
    close: () => {
      closed = true;
    }
  };
};

const requireState = (
  result: ReturnType<BackgroundAgentStateStore["read"]>
): BackgroundAgentState => {
  if (result.kind === "missing")
    throw new Error("Background Agent state is not initialized.");
  if (result.kind === "invalid")
    throw new Error("Background Agent state is invalid.");
  return result.state;
};

const staleGenerationResponse = (
  request: BackgroundAgentRequest,
  current: BackgroundAgentState
): BackgroundAgentResponse => ({
  protocolVersion: BACKGROUND_AGENT_PROTOCOL_VERSION,
  requestId: request.requestId,
  installationId: request.installationId,
  homeIdentity: request.homeIdentity,
  kind: request.kind,
  generation: current.generation,
  state: current.stopIntent ? "stopped" : current.state,
  ok: false,
  errorCode: "stale_generation",
  message: "Background Agent generation is stale."
});

const isRuntimeReady = (value: unknown) =>
  isRecord(value) &&
  value.ok === true &&
  (value.state === "healthy" || value.state === "ready");

const isRuntimeTerminal = (value: unknown) => {
  if (!isRecord(value)) return false;
  const lifecycle = isRecord(value.lifecycle) ? value.lifecycle : undefined;
  if (lifecycle?.state === "starting") return false;
  return (
    lifecycle?.state === "stopped" ||
    lifecycle?.state === "unavailable" ||
    (value.ok === false && value.state === "needs_attention")
  );
};

const isOperationSuccessful = (value: unknown) =>
  isRecord(value) && value.ok === true;

const operationMessage = (value: unknown, fallback: string) =>
  isRecord(value) && typeof value.message === "string"
    ? value.message
    : isRecord(value) && typeof value.error === "string"
      ? value.error
      : fallback;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

const isStaleGenerationError = (error: unknown) =>
  error instanceof Error && error.message.includes("generation is stale");

const isStopIntentError = (error: unknown) =>
  error instanceof Error && error.message.includes("stop intent");
