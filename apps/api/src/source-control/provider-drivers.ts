import {
  fetchBoundedJson,
  sourceControlBranchSchema,
  sourceControlCheckSchema,
  sourceControlCommentSchema,
  sourceControlReviewRequestSchema,
  type SourceControlBranch,
  type SourceControlCheck,
  type SourceControlComment,
  type SourceControlConnection,
  type SourceControlProvider,
  type SourceControlReviewRequest
} from "@koed/shared";

export type SourceControlCredential =
  | { scheme: "bearer"; token: string }
  | { scheme: "basic"; username: string; token: string };

export interface SourceControlProviderRepository {
  namespace: string;
  repository: string;
  project: string | null;
}

export interface SourceControlProviderDriver {
  readonly provider: SourceControlProvider;
  inspect(input: ProviderInput): Promise<{
    defaultBranch: string;
    headObjectId: string;
  }>;
  branches(input: ProviderInput): Promise<SourceControlBranch[]>;
  reviewRequests(
    input: ProviderInput & { state: "open" | "closed" | "all" }
  ): Promise<SourceControlReviewRequest[]>;
  reviewRequest(
    input: ProviderInput & { number: number }
  ): Promise<SourceControlReviewRequest>;
  checks(
    input: ProviderInput & { objectId: string }
  ): Promise<SourceControlCheck[]>;
  comments(
    input: ProviderInput & { number: number }
  ): Promise<SourceControlComment[]>;
  createReviewRequest(
    input: ProviderInput & {
      title: string;
      body: string;
      sourceBranch: string;
      targetBranch: string;
      draft: boolean;
    }
  ): Promise<SourceControlReviewRequest>;
  createComment(
    input: ProviderInput & { number: number; body: string }
  ): Promise<SourceControlComment>;
  createReview(
    input: ProviderInput & {
      number: number;
      decision: "comment" | "approve" | "request_changes";
      body: string;
      expectedHeadObjectId: string;
    }
  ): Promise<void>;
}

export interface ProviderInput {
  connection: SourceControlConnection;
  credential: SourceControlCredential;
  repository: SourceControlProviderRepository;
  fetch: typeof fetch;
}

const providerError = (status: number): never => {
  const code =
    status === 401 || status === 403
      ? "source_control_unauthorized"
      : status === 404
        ? "source_control_not_found"
        : status === 409 || status === 412 || status === 422
          ? "source_control_stale"
          : status === 429
            ? "source_control_rate_limited"
            : "source_control_provider_failed";
  throw Object.assign(new Error("Source-control provider request failed"), {
    statusCode: status >= 500 ? 502 : status,
    code
  });
};

const authHeader = (credential: SourceControlCredential): string =>
  credential.scheme === "bearer"
    ? `Bearer ${credential.token}`
    : `Basic ${Buffer.from(
        `${credential.username}:${credential.token}`,
        "utf8"
      ).toString("base64")}`;

const request = async (
  input: ProviderInput,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  accept = "application/json"
): Promise<unknown> => {
  const base = new URL(input.connection.apiOrigin);
  const basePath = base.pathname.replace(/\/+$/, "");
  const parsedPath = new URL(path, "https://koed.invalid");
  base.pathname = `${basePath}/${parsedPath.pathname.replace(/^\/+/, "")}`;
  base.search = parsedPath.search;
  base.hash = "";
  const { response, payload } = await fetchBoundedJson(
    input.fetch,
    base,
    {
      method,
      redirect: "error",
      headers: {
        accept,
        authorization: authHeader(input.credential),
        ...(body ? { "content-type": "application/json" } : {}),
        "user-agent": "koed-source-control/1"
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    },
    { timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024, readErrorBody: false }
  );
  if (!response.ok) providerError(response.status);
  return payload;
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Source-control provider returned an invalid object");
  }
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error("Source-control provider returned an invalid list");
  }
  return value.slice(0, 100);
};
const text = (value: unknown, fallback = "unknown"): string =>
  typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown): number => {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error("Source-control provider returned an invalid number");
  }
  return result;
};
const iso = (value: unknown): string => {
  const parsed = new Date(text(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Source-control provider returned an invalid timestamp");
  }
  return parsed.toISOString();
};
const encode = (value: string): string => encodeURIComponent(value);

const githubRepo = (input: ProviderInput): string =>
  `/repos/${encode(input.repository.namespace)}/${encode(
    input.repository.repository
  )}`;
const githubReview = (value: unknown): SourceControlReviewRequest => {
  const item = record(value);
  const head = record(item.head);
  const base = record(item.base);
  const user = record(item.user);
  return sourceControlReviewRequestSchema.parse({
    id: text(item.node_id, String(item.id)),
    number: number(item.number),
    title: text(item.title),
    state: item.merged_at
      ? "merged"
      : item.state === "open"
        ? "open"
        : "closed",
    draft: item.draft === true,
    sourceBranch: text(head.ref),
    targetBranch: text(base.ref),
    headObjectId: text(head.sha),
    author: text(user.login),
    webUrl: text(item.html_url),
    updatedAt: iso(item.updated_at)
  });
};

const github: SourceControlProviderDriver = {
  provider: "github",
  async inspect(input) {
    const repository = record(await request(input, "GET", githubRepo(input)));
    const defaultBranch = text(repository.default_branch);
    const branch = record(
      await request(
        input,
        "GET",
        `${githubRepo(input)}/branches/${encode(defaultBranch)}`
      )
    );
    return { defaultBranch, headObjectId: text(record(branch.commit).sha) };
  },
  async branches(input) {
    return array(
      await request(input, "GET", `${githubRepo(input)}/branches?per_page=100`)
    ).map((value) => {
      const item = record(value);
      return sourceControlBranchSchema.parse({
        name: text(item.name),
        objectId: text(record(item.commit).sha),
        default: false,
        protected: item.protected === true
      });
    });
  },
  async reviewRequests(input) {
    const state = input.state === "all" ? "all" : input.state;
    return array(
      await request(
        input,
        "GET",
        `${githubRepo(input)}/pulls?state=${state}&per_page=100`
      )
    ).map(githubReview);
  },
  async reviewRequest(input) {
    return githubReview(
      await request(input, "GET", `${githubRepo(input)}/pulls/${input.number}`)
    );
  },
  async checks(input) {
    const payload = record(
      await request(
        input,
        "GET",
        `${githubRepo(input)}/commits/${input.objectId}/check-runs?per_page=100`,
        undefined,
        "application/vnd.github+json"
      )
    );
    return array(payload.check_runs).map((value) => {
      const item = record(value);
      return sourceControlCheckSchema.parse({
        id: String(item.id),
        name: text(item.name),
        state:
          item.status === "completed"
            ? "completed"
            : item.status === "in_progress"
              ? "running"
              : "queued",
        conclusion: item.conclusion ?? null,
        webUrl: typeof item.html_url === "string" ? item.html_url : null
      });
    });
  },
  async comments(input) {
    return array(
      await request(
        input,
        "GET",
        `${githubRepo(input)}/issues/${input.number}/comments?per_page=100`
      )
    ).map((value) => {
      const item = record(value);
      return sourceControlCommentSchema.parse({
        id: String(item.id),
        author: text(record(item.user).login),
        body: typeof item.body === "string" ? item.body : "",
        createdAt: iso(item.created_at),
        webUrl: typeof item.html_url === "string" ? item.html_url : null
      });
    });
  },
  async createReviewRequest(input) {
    return githubReview(
      await request(input, "POST", `${githubRepo(input)}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.sourceBranch,
        base: input.targetBranch,
        draft: input.draft
      })
    );
  },
  async createComment(input) {
    const item = record(
      await request(
        input,
        "POST",
        `${githubRepo(input)}/issues/${input.number}/comments`,
        { body: input.body }
      )
    );
    return sourceControlCommentSchema.parse({
      id: String(item.id),
      author: text(record(item.user).login),
      body: text(item.body),
      createdAt: iso(item.created_at),
      webUrl: typeof item.html_url === "string" ? item.html_url : null
    });
  },
  async createReview(input) {
    await request(
      input,
      "POST",
      `${githubRepo(input)}/pulls/${input.number}/reviews`,
      {
        body: input.body,
        event:
          input.decision === "approve"
            ? "APPROVE"
            : input.decision === "request_changes"
              ? "REQUEST_CHANGES"
              : "COMMENT"
      }
    );
  }
};

const gitlabProject = (input: ProviderInput): string =>
  `/projects/${encode(
    `${input.repository.namespace}/${input.repository.repository}`
  )}`;
const gitlabReview = (value: unknown): SourceControlReviewRequest => {
  const item = record(value);
  const author = record(item.author);
  const diffRefs = record(item.diff_refs ?? {});
  return sourceControlReviewRequestSchema.parse({
    id: String(item.id),
    number: number(item.iid),
    title: text(item.title),
    state:
      item.state === "merged"
        ? "merged"
        : item.state === "opened"
          ? "open"
          : "closed",
    draft: item.draft === true || /^draft:/i.test(text(item.title)),
    sourceBranch: text(item.source_branch),
    targetBranch: text(item.target_branch),
    headObjectId: text(diffRefs.head_sha ?? item.sha),
    author: text(author.username ?? author.name),
    webUrl: text(item.web_url),
    updatedAt: iso(item.updated_at)
  });
};

const gitlab: SourceControlProviderDriver = {
  provider: "gitlab",
  async inspect(input) {
    const repository = record(
      await request(input, "GET", gitlabProject(input))
    );
    const defaultBranch = text(repository.default_branch);
    const branch = record(
      await request(
        input,
        "GET",
        `${gitlabProject(input)}/repository/branches/${encode(defaultBranch)}`
      )
    );
    return { defaultBranch, headObjectId: text(record(branch.commit).id) };
  },
  async branches(input) {
    const repository = record(
      await request(input, "GET", gitlabProject(input))
    );
    return array(
      await request(
        input,
        "GET",
        `${gitlabProject(input)}/repository/branches?per_page=100`
      )
    ).map((value) => {
      const item = record(value);
      return sourceControlBranchSchema.parse({
        name: text(item.name),
        objectId: text(record(item.commit).id),
        default: item.name === repository.default_branch,
        protected: item.protected === true
      });
    });
  },
  async reviewRequests(input) {
    const state =
      input.state === "all"
        ? "all"
        : input.state === "open"
          ? "opened"
          : "closed";
    return array(
      await request(
        input,
        "GET",
        `${gitlabProject(input)}/merge_requests?state=${state}&per_page=100`
      )
    ).map(gitlabReview);
  },
  async reviewRequest(input) {
    return gitlabReview(
      await request(
        input,
        "GET",
        `${gitlabProject(input)}/merge_requests/${input.number}`
      )
    );
  },
  async checks(input) {
    return array(
      await request(
        input,
        "GET",
        `${gitlabProject(input)}/pipelines?sha=${input.objectId}&per_page=100`
      )
    ).map((value) => {
      const item = record(value);
      const status = text(item.status);
      return sourceControlCheckSchema.parse({
        id: String(item.id),
        name: `Pipeline ${item.id}`,
        state: [
          "created",
          "pending",
          "preparing",
          "waiting_for_resource"
        ].includes(status)
          ? "queued"
          : status === "running"
            ? "running"
            : "completed",
        conclusion:
          status === "success"
            ? "success"
            : status === "failed"
              ? "failure"
              : status === "canceled"
                ? "canceled"
                : status === "skipped"
                  ? "skipped"
                  : null,
        webUrl: typeof item.web_url === "string" ? item.web_url : null
      });
    });
  },
  async comments(input) {
    return array(
      await request(
        input,
        "GET",
        `${gitlabProject(input)}/merge_requests/${input.number}/notes?per_page=100`
      )
    ).map((value) => {
      const item = record(value);
      return sourceControlCommentSchema.parse({
        id: String(item.id),
        author: text(record(item.author).username),
        body: typeof item.body === "string" ? item.body : "",
        createdAt: iso(item.created_at),
        webUrl: null
      });
    });
  },
  async createReviewRequest(input) {
    return gitlabReview(
      await request(input, "POST", `${gitlabProject(input)}/merge_requests`, {
        title: input.draft ? `Draft: ${input.title}` : input.title,
        description: input.body,
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch
      })
    );
  },
  async createComment(input) {
    const item = record(
      await request(
        input,
        "POST",
        `${gitlabProject(input)}/merge_requests/${input.number}/notes`,
        { body: input.body }
      )
    );
    return sourceControlCommentSchema.parse({
      id: String(item.id),
      author: text(record(item.author).username),
      body: text(item.body),
      createdAt: iso(item.created_at),
      webUrl: null
    });
  },
  async createReview(input) {
    if (input.decision === "approve") {
      await request(
        input,
        "POST",
        `${gitlabProject(input)}/merge_requests/${input.number}/approve`,
        { sha: input.expectedHeadObjectId }
      );
      if (input.body) await this.createComment(input);
      return;
    }
    await this.createComment(input);
  }
};

const bitbucketRepo = (input: ProviderInput): string =>
  `/repositories/${encode(input.repository.namespace)}/${encode(
    input.repository.repository
  )}`;
const bitbucketList = (value: unknown): unknown[] =>
  array(record(value).values);
const bitbucketReview = (value: unknown): SourceControlReviewRequest => {
  const item = record(value);
  const source = record(item.source);
  const destination = record(item.destination);
  const sourceCommit = record(source.commit);
  const author = record(item.author);
  const links = record(item.links);
  const html = record(links.html);
  return sourceControlReviewRequestSchema.parse({
    id: String(item.id),
    number: number(item.id),
    title: text(item.title),
    state:
      item.state === "MERGED"
        ? "merged"
        : item.state === "OPEN"
          ? "open"
          : "closed",
    draft: item.draft === true,
    sourceBranch: text(record(source.branch).name),
    targetBranch: text(record(destination.branch).name),
    headObjectId: text(sourceCommit.hash),
    author: text(author.nickname ?? author.display_name),
    webUrl: text(html.href),
    updatedAt: iso(item.updated_on)
  });
};

const bitbucket: SourceControlProviderDriver = {
  provider: "bitbucket",
  async inspect(input) {
    const repository = record(
      await request(input, "GET", bitbucketRepo(input))
    );
    const defaultBranch = text(record(repository.mainbranch).name);
    const branch = record(
      await request(
        input,
        "GET",
        `${bitbucketRepo(input)}/refs/branches/${encode(defaultBranch)}`
      )
    );
    return { defaultBranch, headObjectId: text(record(branch.target).hash) };
  },
  async branches(input) {
    const repository = record(
      await request(input, "GET", bitbucketRepo(input))
    );
    const defaultBranch = text(record(repository.mainbranch).name);
    return bitbucketList(
      await request(
        input,
        "GET",
        `${bitbucketRepo(input)}/refs/branches?pagelen=100`
      )
    ).map((value) => {
      const item = record(value);
      return sourceControlBranchSchema.parse({
        name: text(item.name),
        objectId: text(record(item.target).hash),
        default: item.name === defaultBranch,
        protected: null
      });
    });
  },
  async reviewRequests(input) {
    const state =
      input.state === "all"
        ? ""
        : `&state=${input.state === "open" ? "OPEN" : "DECLINED"}`;
    return bitbucketList(
      await request(
        input,
        "GET",
        `${bitbucketRepo(input)}/pullrequests?pagelen=100${state}`
      )
    ).map(bitbucketReview);
  },
  async reviewRequest(input) {
    return bitbucketReview(
      await request(
        input,
        "GET",
        `${bitbucketRepo(input)}/pullrequests/${input.number}`
      )
    );
  },
  async checks(input) {
    return bitbucketList(
      await request(
        input,
        "GET",
        `${bitbucketRepo(input)}/commit/${input.objectId}/statuses?pagelen=100`
      )
    ).map((value) => {
      const item = record(value);
      const state = text(item.state);
      return sourceControlCheckSchema.parse({
        id: text(item.key, String(item.uuid)),
        name: text(item.name, text(item.key)),
        state: state === "INPROGRESS" ? "running" : "completed",
        conclusion:
          state === "SUCCESSFUL"
            ? "success"
            : state === "FAILED"
              ? "failure"
              : null,
        webUrl: typeof item.url === "string" ? item.url : null
      });
    });
  },
  async comments(input) {
    return bitbucketList(
      await request(
        input,
        "GET",
        `${bitbucketRepo(input)}/pullrequests/${input.number}/comments?pagelen=100`
      )
    ).map((value) => {
      const item = record(value);
      return sourceControlCommentSchema.parse({
        id: String(item.id),
        author: text(record(item.user).nickname),
        body: text(record(item.content).raw, ""),
        createdAt: iso(item.created_on),
        webUrl: null
      });
    });
  },
  async createReviewRequest(input) {
    return bitbucketReview(
      await request(input, "POST", `${bitbucketRepo(input)}/pullrequests`, {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.sourceBranch } },
        destination: { branch: { name: input.targetBranch } }
      })
    );
  },
  async createComment(input) {
    const item = record(
      await request(
        input,
        "POST",
        `${bitbucketRepo(input)}/pullrequests/${input.number}/comments`,
        {
          content: { raw: input.body }
        }
      )
    );
    return sourceControlCommentSchema.parse({
      id: String(item.id),
      author: text(record(item.user).nickname),
      body: text(record(item.content).raw),
      createdAt: iso(item.created_on),
      webUrl: null
    });
  },
  async createReview(input) {
    if (input.decision === "approve") {
      await request(
        input,
        "POST",
        `${bitbucketRepo(input)}/pullrequests/${input.number}/approve`
      );
      if (input.body) await this.createComment(input);
      return;
    }
    await this.createComment(input);
  }
};

const azureRepo = (input: ProviderInput): string => {
  if (!input.repository.project) {
    throw new Error("Azure DevOps repository requires a project binding");
  }
  return `/${encode(input.repository.namespace)}/${encode(
    input.repository.project
  )}/_apis/git/repositories/${encode(input.repository.repository)}`;
};
const azureList = (value: unknown): unknown[] => array(record(value).value);
const azureReview = (value: unknown): SourceControlReviewRequest => {
  const item = record(value);
  const repository = record(item.repository);
  const webUrl = text(item.url).replace(
    /\/_apis\/git\/.+$/u,
    `/_git/${text(repository.name)}/pullrequest/${item.pullRequestId}`
  );
  return sourceControlReviewRequestSchema.parse({
    id: String(item.pullRequestId),
    number: number(item.pullRequestId),
    title: text(item.title),
    state:
      item.status === "completed"
        ? "merged"
        : item.status === "active"
          ? "open"
          : "closed",
    draft: item.isDraft === true,
    sourceBranch: text(item.sourceRefName).replace(/^refs\/heads\//u, ""),
    targetBranch: text(item.targetRefName).replace(/^refs\/heads\//u, ""),
    headObjectId: text(
      item.lastMergeSourceCommit
        ? record(item.lastMergeSourceCommit).commitId
        : item.lastMergeCommit
          ? record(item.lastMergeCommit).commitId
          : undefined
    ),
    author: text(record(item.createdBy).displayName),
    webUrl,
    updatedAt: iso(item.creationDate)
  });
};

const azure: SourceControlProviderDriver = {
  provider: "azure_devops",
  async inspect(input) {
    const repository = record(
      await request(input, "GET", `${azureRepo(input)}?api-version=7.1`)
    );
    const defaultRef = text(repository.defaultBranch);
    const refs = azureList(
      await request(
        input,
        "GET",
        `${azureRepo(input)}/refs?filter=${encode(defaultRef)}&api-version=7.1`
      )
    );
    return {
      defaultBranch: defaultRef.replace(/^refs\/heads\//u, ""),
      headObjectId: text(record(refs[0]).objectId)
    };
  },
  async branches(input) {
    return azureList(
      await request(
        input,
        "GET",
        `${azureRepo(input)}/refs?filter=heads/&api-version=7.1`
      )
    ).map((value) => {
      const item = record(value);
      return sourceControlBranchSchema.parse({
        name: text(item.name).replace(/^refs\/heads\//u, ""),
        objectId: text(item.objectId),
        default: false,
        protected: null
      });
    });
  },
  async reviewRequests(input) {
    const status =
      input.state === "all"
        ? "all"
        : input.state === "open"
          ? "active"
          : "completed";
    return azureList(
      await request(
        input,
        "GET",
        `${azureRepo(input)}/pullrequests?searchCriteria.status=${status}&$top=100&api-version=7.1`
      )
    ).map(azureReview);
  },
  async reviewRequest(input) {
    return azureReview(
      await request(
        input,
        "GET",
        `${azureRepo(input)}/pullrequests/${input.number}?api-version=7.1`
      )
    );
  },
  async checks(input) {
    const project = input.repository.project!;
    return azureList(
      await request(
        input,
        "GET",
        `/${encode(input.repository.namespace)}/${encode(project)}/_apis/build/builds?repositoryId=${encode(input.repository.repository)}&sourceVersion=${input.objectId}&$top=100&api-version=7.1`
      )
    ).map((value) => {
      const item = record(value);
      const status = text(item.status);
      const result = text(item.result, "");
      return sourceControlCheckSchema.parse({
        id: String(item.id),
        name: text(record(item.definition).name),
        state:
          status === "completed"
            ? "completed"
            : status === "inProgress"
              ? "running"
              : "queued",
        conclusion:
          result === "succeeded"
            ? "success"
            : result === "failed"
              ? "failure"
              : result === "canceled"
                ? "canceled"
                : null,
        webUrl:
          typeof item._links === "object"
            ? text(record(record(item._links).web).href, null as never)
            : null
      });
    });
  },
  async comments(input) {
    const threads = azureList(
      await request(
        input,
        "GET",
        `${azureRepo(input)}/pullrequests/${input.number}/threads?api-version=7.1`
      )
    );
    return threads.flatMap((value) =>
      array(record(value).comments).map((comment) => {
        const item = record(comment);
        return sourceControlCommentSchema.parse({
          id: String(item.id),
          author: text(record(item.author).displayName),
          body: typeof item.content === "string" ? item.content : "",
          createdAt: iso(item.publishedDate),
          webUrl: null
        });
      })
    );
  },
  async createReviewRequest(input) {
    return azureReview(
      await request(
        input,
        "POST",
        `${azureRepo(input)}/pullrequests?api-version=7.1`,
        {
          title: input.title,
          description: input.body,
          sourceRefName: `refs/heads/${input.sourceBranch}`,
          targetRefName: `refs/heads/${input.targetBranch}`,
          isDraft: input.draft
        }
      )
    );
  },
  async createComment(input) {
    const thread = record(
      await request(
        input,
        "POST",
        `${azureRepo(input)}/pullrequests/${input.number}/threads?api-version=7.1`,
        {
          comments: [
            { parentCommentId: 0, content: input.body, commentType: 1 }
          ],
          status: 1
        }
      )
    );
    const item = record(array(thread.comments)[0]);
    return sourceControlCommentSchema.parse({
      id: String(item.id),
      author: text(record(item.author).displayName),
      body: text(item.content),
      createdAt: iso(item.publishedDate),
      webUrl: null
    });
  },
  async createReview(input) {
    if (input.body) await this.createComment(input);
    if (input.decision === "comment") return;
    throw Object.assign(new Error("Azure DevOps vote identity is not bound"), {
      statusCode: 409,
      code: "source_control_capability_unavailable"
    });
  }
};

const drivers: Record<SourceControlProvider, SourceControlProviderDriver> = {
  github,
  gitlab,
  bitbucket,
  azure_devops: azure
};

export const sourceControlProviderDriver = (
  provider: SourceControlProvider
): SourceControlProviderDriver => drivers[provider]!;
