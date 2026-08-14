import { readFile } from "node:fs/promises";
import { z } from "zod";

export const REQUIRED_AUTHORIZATION_BOUNDARIES = [
  "cross_user",
  "cross_team",
  "cross_workspace",
  "revoked",
  "private",
  "removed_member",
  "retained",
  "captured",
  "uncaptured",
  "api_token_team_denial"
] as const;

const authorizationProbeSchema = z
  .object({
    id: z.string().min(1),
    boundary: z.enum(REQUIRED_AUTHORIZATION_BOUNDARIES),
    authorizationEnv: z.string().min(1),
    query: z.string().min(1),
    teamWorkspaceId: z.string().uuid().optional(),
    projectId: z.string().min(1).optional(),
    expectedHttpStatus: z.number().int().min(100).max(599).default(200),
    mustContain: z.array(z.string().min(1)).default([]),
    mustNotContain: z.array(z.string().min(1)).default([])
  })
  .strict();

export const authorizationManifestSchema = z
  .object({
    schemaVersion: z.literal("koed-retrieval-authorization-v1"),
    baseUrl: z.string().url().optional(),
    probes: z.array(authorizationProbeSchema).min(1)
  })
  .strict()
  .superRefine((manifest, context) => {
    const present = new Set(manifest.probes.map((probe) => probe.boundary));
    for (const boundary of REQUIRED_AUTHORIZATION_BOUNDARIES) {
      if (!present.has(boundary)) {
        context.addIssue({
          code: "custom",
          path: ["probes"],
          message: `authorization manifest is missing required ${boundary} probe`
        });
      }
    }
  });

export interface AuthorizationProbeResult {
  id: string;
  boundary: z.infer<typeof authorizationProbeSchema>["boundary"];
  passed: boolean;
  httpStatus: number | null;
  checks: { status: boolean; included: boolean; excluded: boolean };
  error?: string;
}

export interface AuthorizationHarnessReport {
  schemaVersion: "koed-retrieval-authorization-report-v1";
  passed: boolean;
  probes: AuthorizationProbeResult[];
}

const authorizationOutputContent = (body: string): string => {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return body;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (payload === null || payload === undefined) return "";
    if (
      typeof payload === "string" ||
      typeof payload === "number" ||
      typeof payload === "boolean" ||
      typeof payload === "bigint"
    ) {
      return String(payload);
    }
    return "";
  }
  const record = payload as Record<string, unknown>;
  const bundle =
    record.evidenceBundle && typeof record.evidenceBundle === "object"
      ? (record.evidenceBundle as Record<string, unknown>)
      : undefined;
  return JSON.stringify({
    markdown: record.markdown,
    answer: record.answer,
    structuredAnswer: record.structuredAnswer,
    evidence: record.evidence,
    hits: record.hits,
    evidenceBundle: bundle ? { evidence: bundle.evidence } : undefined
  });
};

export const runProductAuthorizationHarness = async (options: {
  manifestPath: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthorizationHarnessReport> => {
  const manifest = authorizationManifestSchema.parse(
    JSON.parse(await readFile(options.manifestPath, "utf8"))
  );
  const baseUrl = options.baseUrl ?? manifest.baseUrl;
  if (!baseUrl) throw new Error("authorization harness requires a base URL");
  const environment = options.env ?? process.env;
  const probes: AuthorizationProbeResult[] = [];
  for (const probe of manifest.probes) {
    const authorization = environment[probe.authorizationEnv]?.trim();
    if (!authorization) {
      probes.push({
        id: probe.id,
        boundary: probe.boundary,
        passed: false,
        httpStatus: null,
        checks: { status: false, included: false, excluded: false },
        error: `credential environment variable ${probe.authorizationEnv} is unset`
      });
      continue;
    }
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/v1/memory/answer`,
        {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({
            query: probe.query,
            retrieval_scope: "personal",
            search_domain: probe.projectId ? "project" : "global",
            project_id: probe.projectId,
            team_workspace_id: probe.teamWorkspaceId,
            strict_limit: true,
            limit: 50
          })
        }
      );
      const body = await response.text();
      const outputContent = authorizationOutputContent(body);
      const checks = {
        status: response.status === probe.expectedHttpStatus,
        included: probe.mustContain.every((sentinel) =>
          outputContent.includes(sentinel)
        ),
        excluded: probe.mustNotContain.every(
          (sentinel) => !outputContent.includes(sentinel)
        )
      };
      probes.push({
        id: probe.id,
        boundary: probe.boundary,
        passed: Object.values(checks).every(Boolean),
        httpStatus: response.status,
        checks
      });
    } catch (error) {
      probes.push({
        id: probe.id,
        boundary: probe.boundary,
        passed: false,
        httpStatus: null,
        checks: { status: false, included: false, excluded: false },
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    schemaVersion: "koed-retrieval-authorization-report-v1",
    passed: probes.every((probe) => probe.passed),
    probes
  };
};
