"use client";

import { loadStudioCsrfToken } from "./studio-csrf";

export type PersonalRemovalTarget =
  | Readonly<{
      kind: "project";
      projectId: string;
      aliases?: readonly string[];
    }>
  | Readonly<{
      kind: "conversation";
      sourceId: string;
      aliases?: readonly string[];
    }>;

export type PersonalRemoval = PersonalRemovalTarget;

type WireRemoval = Readonly<{
  kind: "project" | "conversation";
  id: string;
  aliases?: readonly string[];
}>;

function hostedStudio(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.pathname === "/studio" ||
    window.location.pathname.startsWith("/studio/")
  );
}

function endpoint(): string {
  return hostedStudio()
    ? "/v1/studio/personal-removals"
    : "/studio-api/personal-removals";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseRemoval(value: unknown): PersonalRemoval {
  if (
    !isRecord(value) ||
    (value.kind !== "project" && value.kind !== "conversation") ||
    typeof value.id !== "string" ||
    !value.id.trim()
  ) {
    throw new Error("The Studio removal service returned invalid data.");
  }
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.filter(
        (alias): alias is string => typeof alias === "string" && !!alias.trim()
      )
    : [];
  return value.kind === "project"
    ? { kind: "project", projectId: value.id, aliases }
    : { kind: "conversation", sourceId: value.id, aliases };
}

function toWireTarget(target: PersonalRemovalTarget): WireRemoval {
  return {
    kind: target.kind,
    id: target.kind === "project" ? target.projectId : target.sourceId,
    aliases: target.aliases ?? []
  };
}

async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(
      response.status === 503
        ? "Studio removals are unavailable right now."
        : "Studio could not save this removal."
    );
  }
  return response.json();
}

async function request(
  path: string,
  init: RequestInit,
  fetcher: typeof fetch
): Promise<Response> {
  return fetcher(path, {
    ...init,
    cache: "no-store",
    credentials: "include",
    redirect: "error"
  });
}

export async function listPersonalRemovals(
  fetcher: typeof fetch = fetch
): Promise<PersonalRemoval[]> {
  const payload = await checkedJson(
    await request(endpoint(), { method: "GET" }, fetcher)
  );
  if (!isRecord(payload) || !Array.isArray(payload.removals)) {
    throw new Error("The Studio removal service returned invalid data.");
  }
  return payload.removals.map(parseRemoval);
}

export async function setPersonalRemoval(
  target: PersonalRemovalTarget,
  removed: boolean,
  fetcher: typeof fetch = fetch
): Promise<void> {
  const hosted = hostedStudio();
  const headers = new Headers({ "content-type": "application/json" });
  if (!hosted) {
    headers.set("x-studio-csrf", await loadStudioCsrfToken(fetcher));
  }
  await checkedJson(
    await request(
      endpoint(),
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...toWireTarget(target), removed })
      },
      fetcher
    )
  );
}
