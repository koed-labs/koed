'use client';

import { useEffect, useState } from "react";

export type RegisteredLocalProject = {
  id: string;
  name: string;
  lastSeenAt: string | null;
};

export type SelectedLocalProjectFolder = {
  path: string;
  selectionId: string;
};

export async function listRegisteredLocalProjects(): Promise<RegisteredLocalProject[]> {
  const response = await fetch("/studio-api/projects", {
    headers: { accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin"
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object" || !Array.isArray((body as { projects?: unknown }).projects)) {
    throw new Error("The local Project list is unavailable.");
  }
  const projects = (body as { projects: unknown[] }).projects.flatMap((value): RegisteredLocalProject[] => {
    if (!value || typeof value !== "object") return [];
    const project = value as { id?: unknown; name?: unknown; lastSeenAt?: unknown };
    return typeof project.id === "string" && typeof project.name === "string" &&
      (project.lastSeenAt === null || typeof project.lastSeenAt === "string")
      ? [{ id: project.id, name: project.name, lastSeenAt: project.lastSeenAt }]
      : [];
  });
  return projects;
}

export function useLocalProjectCapabilities(): {
  canCreateLocalProject: boolean;
  loading: boolean;
} {
  const [capabilities, setCapabilities] = useState({
    canCreateLocalProject: false,
    loading: true
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/studio-api/projects/capabilities", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const payload: unknown = await response.json().catch(() => null);
        return Boolean(
          payload &&
            typeof payload === "object" &&
            (payload as { canCreateLocalProject?: unknown })
              .canCreateLocalProject === true
        );
      })
      .then((allowed) => {
        if (!controller.signal.aborted) {
          setCapabilities({ canCreateLocalProject: allowed, loading: false });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCapabilities({ canCreateLocalProject: false, loading: false });
        }
      });
    return () => controller.abort();
  }, []);

  return capabilities;
}

export function useCanCreateLocalProject(): boolean {
  return useLocalProjectCapabilities().canCreateLocalProject;
}

async function csrfToken(): Promise<string> {
  const response = await fetch("/studio-api/projects/session", {
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.csrfToken !== "string") {
    throw new Error("Project setup is unavailable right now.");
  }
  return body.csrfToken;
}

async function projectWrite(path: string, body: Record<string, string>) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-studio-csrf": await csrfToken()
    },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      response.status === 501
        ? "The native project folder picker is available in Koed Studio for Electron."
        : response.status === 400 && result?.error === "folder_selection_expired"
          ? "The folder selection expired. Choose the folder again."
          : "Koed could not register this project. Try again."
    );
  }
  return result;
}

export async function chooseLocalProjectFolder(): Promise<SelectedLocalProjectFolder | null> {
  const result = await projectWrite("/studio-api/projects/choose-folder", {});
  if (result?.canceled === true) return null;
  if (
    result?.canceled !== false ||
    typeof result.path !== "string" ||
    !result.path ||
    typeof result.selectionId !== "string" ||
    !result.selectionId
  ) throw new Error("Koed returned an invalid folder selection.");
  return { path: result.path, selectionId: result.selectionId };
}

export async function registerLocalProject(input: {
  name: string;
  selectionId: string;
}): Promise<RegisteredLocalProject> {
  const result = await projectWrite("/studio-api/projects", input);
  const project = result?.project;
  if (
    typeof project?.id !== "string" ||
    typeof project?.name !== "string" ||
    (project.lastSeenAt !== null && typeof project.lastSeenAt !== "string")
  ) throw new Error("Koed returned an invalid Project record.");
  return project;
}
