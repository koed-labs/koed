export type HomeState = "ready" | "partial" | "unavailable" | "unauthorized";

export type HomeExecution = {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  title: string;
  provider: string;
  state: string;
  updatedAt: string;
  error: string | null;
};

export type HomeRequest = {
  id: string;
  executionId: string;
  sessionId: string | null;
  title: string;
  kind: string;
  updatedAt: string;
};

export type HomeRecent = {
  id: string;
  sessionId: string;
  projectId: string | null;
  projectName: string;
  title: string;
  provider: string | null;
  updatedAt: string;
};

export type HomeSnapshot = {
  state: HomeState;
  fetchedAt: string;
  scopeKey: string | null;
  message: string | null;
  warnings: string[];
  coverage: {
    executions: boolean;
    requests: boolean;
    recents: boolean;
  };
  executions: HomeExecution[];
  requests: HomeRequest[];
  recents: HomeRecent[];
};
