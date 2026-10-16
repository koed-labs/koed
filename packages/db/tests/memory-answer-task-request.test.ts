import { expect, it } from "vitest";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import {
  validateMemoryAnswerTaskRequest,
  validateMemoryAnswerTaskCompletion
} from "../src/memory-answer-task-request.js";
const identity: RepositoryIdentity = {
  kind: "portable_repository",
  key: "gr_current",
  root: "/original",
  branch: "main",
  reason: "origin",
  checkoutId: "checkout_current",
  originatingDeviceId: "device_current",
  selectedRemote: "origin",
  anchorDisplay: null
};
const request = {
  input: {
    query: "Recall decision",
    search_domain: "project",
    project_id: repositoryScopeId(identity),
    repository_context: identity
  }
};
const question = {
  query: "Recall decision",
  searchDomain: "project" as const,
  projectId: repositoryScopeId(identity)
};
it("binds request and completion to pinned Project identity", () => {
  expect(() => validateMemoryAnswerTaskRequest(request)).not.toThrow();
  expect(() =>
    validateMemoryAnswerTaskCompletion(request, null, question)
  ).not.toThrow();
  expect(() =>
    validateMemoryAnswerTaskRequest({
      input: { ...request.input, project_id: "/different" }
    })
  ).toThrow("pinned repository");
  expect(() =>
    validateMemoryAnswerTaskCompletion(request, null, {
      ...question,
      projectId: "/different"
    })
  ).toThrow("project does not match");
});
it("rejects scope, query and Session substitution at completion", () => {
  expect(() =>
    validateMemoryAnswerTaskCompletion(request, "workspace", question)
  ).toThrow("scope does not match");
  expect(() =>
    validateMemoryAnswerTaskCompletion(request, null, {
      ...question,
      query: "Other"
    })
  ).toThrow("query does not match");
  expect(() =>
    validateMemoryAnswerTaskCompletion(request, null, {
      ...question,
      sessionId: "other"
    })
  ).toThrow("search scope does not match");
});
it("requires explicit Personal Global pinning and portable Team Project context", () => {
  expect(() =>
    validateMemoryAnswerTaskRequest({ input: { search_domain: "global" } })
  ).toThrow("explicit null");
  expect(() =>
    validateMemoryAnswerTaskRequest({
      input: { search_domain: "global", repository_context: null }
    })
  ).not.toThrow();
  const local: RepositoryIdentity = {
    ...identity,
    kind: "device_local_repository"
  };
  expect(() =>
    validateMemoryAnswerTaskRequest(
      {
        input: {
          ...request.input,
          repository_context: local,
          project_id: repositoryScopeId(local),
          team_workspace_id: "workspace"
        }
      },
      "workspace"
    )
  ).toThrow("portable repository");
});
