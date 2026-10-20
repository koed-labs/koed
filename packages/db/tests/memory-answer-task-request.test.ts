import { expect, it } from "vitest";
import { repositoryScopeId, type RepositoryIdentity } from "@koed/shared";
import {
  pinMemoryAnswerTaskSelection,
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

const owner = "00000000-0000-4000-8000-000000000001";
it("pins one owner-scoped selection without changing its legacy Project semantics", () => {
  const pinned = pinMemoryAnswerTaskSelection(request, owner);
  expect(pinned).toMatchObject({
    requestVersion: 1,
    input: request.input,
    selection: {
      version: 0,
      ownerUserId: owner,
      target: { kind: "legacy_project", repository: identity },
      callerRepositoryContext: null
    }
  });
  expect(pinMemoryAnswerTaskSelection(pinned, owner)).toEqual(pinned);
  expect(() =>
    pinMemoryAnswerTaskSelection(pinned, "00000000-0000-4000-8000-000000000002")
  ).toThrow("another owner");
  expect(() =>
    validateMemoryAnswerTaskRequest({
      ...pinned,
      input: { ...request.input, project_id: "/other" }
    })
  ).toThrow("accepted Personal selection");
});
it("rejects future task and selection versions without widening or retry", () => {
  const pinned = pinMemoryAnswerTaskSelection(request, owner);
  for (const value of [
    { ...pinned, requestVersion: 2 },
    { ...pinned, selection: { version: 99 } },
    { ...pinned, requestVersion: undefined }
  ])
    expect(() => validateMemoryAnswerTaskRequest(value)).toThrow("Unsupported");
});
it("keeps Global caller context independent and refuses Personal snapshots for Team tasks", () => {
  const global = pinMemoryAnswerTaskSelection(
    {
      input: {
        query: "global",
        search_domain: "global",
        repository_context: identity
      }
    },
    owner
  );
  expect(global).toMatchObject({
    selection: { target: { kind: "global" }, callerRepositoryContext: identity }
  });
  expect(() =>
    validateMemoryAnswerTaskRequest({
      ...global,
      input: {
        query: "global",
        search_domain: "global",
        repository_context: null
      }
    })
  ).toThrow("accepted Personal selection");
  expect(() =>
    pinMemoryAnswerTaskSelection(
      {
        ...global,
        input: {
          query: "global",
          search_domain: "global",
          repository_context: identity,
          team_workspace_id: "workspace"
        }
      },
      owner,
      "workspace"
    )
  ).toThrow("not supported for Team");
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
