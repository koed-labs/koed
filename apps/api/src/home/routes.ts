import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  fetchBoundedJsonObject,
  readLocalEdgeUpstreamRegistry,
  upstreamAdvertisesCapability,
  upstreamApiUrl,
  upstreamBackendById
} from "@koed/shared";
import {
  homeAccessSchema,
  homeReminderMutationResultSchema,
  homeReminderMutationSchema,
  homeSnapshotSchema,
  homeSourceSchema,
  type HomeItem
} from "@koed/shared/home";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import { assertUpstreamOperationPathAllowed } from "../local-edge/upstream-routing.js";

const paramsSchema = z
  .object({
    sourceEventId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/u)
  })
  .strict();
const querySchema = z
  .object({
    source: homeSourceSchema.optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cursor && !value.source)
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "A source is required with a cursor"
      });
  });
const homeSources = [
  "managed_runtime_item",
  "managed_execution",
  "personal_agent_job",
  "pull_request_review"
] as const;

const localExecutionProfiles = new Set(["developer", "local_personal"]);

const authenticateHomeOwner = async (
  request: FastifyRequest,
  context: ApiRouteContext
) => {
  if (localExecutionProfiles.has(context.config.deploymentProfile))
    return context.auth.authenticate(request);
  if (/^Koed-Device\s/i.test(request.headers.authorization?.trim() ?? ""))
    return context.auth.authenticateSessionOrDeviceCredential(
      request,
      "managed_execution"
    );
  return context.auth.authenticateSession(request);
};

const requireHomeRepository = (context: ApiRouteContext) => {
  if (!context.home)
    throw Object.assign(new Error("Home authority is unavailable"), {
      statusCode: 503
    });
  return context.home;
};

const classify = (items: HomeItem[]) => {
  const needsYou = items.filter(
    (item) => item.state === "blocked" || item.state === "review"
  );
  const ongoing = items.filter((item) => item.state === "ongoing");
  const recent = items.filter((item) => item.state === "recent");
  return { needsYou, ongoing, recent };
};

const accountScopeFor = (
  ownerUserId: string,
  context: ApiRouteContext
): string => {
  const authorityDeployment =
    context.deploymentIdentity.inspect().deploymentId ?? "unknown-authority";
  return createHash("sha256")
    .update(`koed-home-owner:${authorityDeployment}:${ownerUserId}`)
    .digest("hex");
};

const getCurrentSnapshotData = async (
  ownerUserId: string,
  context: ApiRouteContext,
  input: z.infer<typeof querySchema>
) => {
  const repository = requireHomeRepository(context);
  const sources = input.source ? [input.source] : homeSources;
  const [pages, badgeCount] = await Promise.all([
    Promise.all(
      sources.map((source) =>
        repository.listSourcePage({
          ownerUserId,
          source,
          cursor: source === input.source ? input.cursor : undefined,
          limit: input.limit
        })
      )
    ),
    repository.countNeedsYou(ownerUserId)
  ]);
  const currentItems = pages.flatMap((page) => page.items);
  const states = await repository.listReminderStates(
    ownerUserId,
    currentItems
      .filter((item) => item.state === "blocked" || item.state === "review")
      .map((item) => item.sourceEventId)
  );
  const stateByIdentity = new Map(
    states.map((state) => [state.sourceEventId, state])
  );
  const coverage = pages.map((page, index) => ({
    source: sources[index]!,
    complete: page.complete,
    nextCursor: page.nextCursor
  }));
  const uncleared: HomeItem[] = [];
  const cleared: HomeItem[] = [];
  for (const item of currentItems) {
    if (item.state !== "blocked" && item.state !== "review") continue;
    const state = stateByIdentity.get(item.sourceEventId);
    if (
      state?.source === item.source &&
      state.sourceId === item.sourceId &&
      state.sourceRevision === item.sourceRevision &&
      state.cleared
    ) {
      cleared.push(item);
    } else {
      uncleared.push(item);
    }
  }
  const { ongoing, recent } = classify(currentItems);
  const accountScope = accountScopeFor(ownerUserId, context);
  return {
    currentItems,
    snapshot: homeSnapshotSchema.parse({
      schemaVersion: "koed.home-feed/v1",
      accountScope,
      generatedAt: new Date().toISOString(),
      coverage,
      needsYou: uncleared,
      cleared,
      ongoing,
      recent,
      badgeCount
    })
  };
};

export const registerHomeRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const remoteAuthority = () => {
    if (!localExecutionProfiles.has(context.config.deploymentProfile))
      return null;
    const registry = readLocalEdgeUpstreamRegistry(
      context.localEdge.upstreamBackendsPath
    );
    const backend = registry.activeBackendId
      ? upstreamBackendById(registry, registry.activeBackendId)
      : null;
    if (!backend || backend.routePolicy.managedExecution !== "enabled")
      return null;
    if (!context.localEdge.remoteOperationsAllowed())
      throw Object.assign(new Error("Home remote operations are suspended"), {
        statusCode: 503
      });
    if (
      backend.capabilities?.state !== "validated" ||
      (backend.capabilities.expiresAt &&
        Date.parse(backend.capabilities.expiresAt) <= Date.now()) ||
      !upstreamAdvertisesCapability(backend, "memory.managedConversations")
    )
      throw Object.assign(
        new Error("Home upstream capabilities are unavailable"),
        {
          statusCode: 503
        }
      );
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization)
      throw Object.assign(new Error("Home upstream is not enrolled"), {
        statusCode: 503
      });
    return { backend, authorization };
  };

  const proxyHome = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown> | null> => {
    const authority = remoteAuthority();
    if (!authority) return null;
    assertUpstreamOperationPathAllowed("managed_execution", method, path);
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamApiUrl(authority.backend.baseUrl, path),
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024, readErrorBody: true }
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Home authority returned HTTP ${response.status}`
        ),
        { statusCode: response.status >= 500 ? 502 : response.status }
      );
    }
    return payload;
  };

  app.get("/v1/home", async (request) => {
    const owner = await authenticateHomeOwner(request, context);
    const query = querySchema.parse(request.query);
    const path = new URLSearchParams();
    if (query.source) path.set("source", query.source);
    if (query.cursor) path.set("cursor", query.cursor);
    if (query.limit !== 100 || query.source)
      path.set("limit", String(query.limit));
    const suffix = path.size > 0 ? `?${path.toString()}` : "";
    const proxied = await proxyHome("GET", `/v1/home${suffix}`);
    if (proxied) return homeSnapshotSchema.parse(proxied);
    return (await getCurrentSnapshotData(owner.id, context, query)).snapshot;
  });

  app.get("/v1/home/access", async (request) => {
    const owner = await authenticateHomeOwner(request, context);
    const proxied = await proxyHome("GET", "/v1/home/access");
    if (proxied) return homeAccessSchema.parse(proxied);
    const authorityDeployment =
      context.deploymentIdentity.inspect().deploymentId ?? "unknown-authority";
    return homeAccessSchema.parse({
      accountScope: accountScopeFor(owner.id, context),
      backendId: authorityDeployment
    });
  });

  const mutate = (cleared: boolean) => async (request: FastifyRequest) => {
    const owner = await authenticateHomeOwner(request, context);
    const params = paramsSchema.parse(request.params);
    const input = homeReminderMutationSchema.parse(request.body);
    const proxied = await proxyHome(
      "POST",
      `/v1/home/reminders/${params.sourceEventId}/${cleared ? "clear" : "restore"}`,
      input
    );
    if (proxied) return homeReminderMutationResultSchema.parse(proxied);
    const [prefix, sourceId] = params.sourceEventId.split(":", 2);
    const canonicalEventId =
      /^(?:runtime|execution|job|pr|pr-op):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        params.sourceEventId
      );
    const sourceByPrefix = {
      runtime: "managed_runtime_item",
      execution: "managed_execution",
      job: "personal_agent_job",
      pr: "pull_request_review",
      "pr-op": "pull_request_review"
    } as const;
    const source = sourceByPrefix[prefix as keyof typeof sourceByPrefix];
    if (
      !source ||
      !sourceId ||
      !canonicalEventId ||
      params.sourceEventId !== `${prefix}:${sourceId}`
    ) {
      throw Object.assign(
        new Error("Home reminder changed or is unavailable"),
        {
          statusCode: 409
        }
      );
    }
    const expectedPrefix: Record<string, string> = {
      managed_runtime_item: "r",
      managed_execution: "v",
      personal_agent_job: "v",
      pull_request_review: "v"
    };
    if (!input.sourceRevision.startsWith(expectedPrefix[source]!))
      throw Object.assign(
        new Error("Home reminder changed or is unavailable"),
        { statusCode: 409 }
      );
    const state = await requireHomeRepository(context).setReminderState({
      ownerUserId: owner.id,
      sourceEventId: params.sourceEventId,
      source,
      sourceId,
      sourceRevision: input.sourceRevision,
      cleared
    });
    return homeReminderMutationResultSchema.parse({
      sourceEventId: state.sourceEventId,
      sourceRevision: state.sourceRevision,
      cleared: state.cleared
    });
  };

  app.post("/v1/home/reminders/:sourceEventId/clear", mutate(true));
  app.post("/v1/home/reminders/:sourceEventId/restore", mutate(false));
};
