import { spawn } from "node:child_process";
import { homedir } from "node:os";

export type GithubReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
export type GithubAccount = {
  host: "github.com";
  login: string;
  active: boolean;
  state: "success" | "error";
};

type ExecFile = (
  file: string,
  args: string[],
  options: Record<string, unknown>
) => Promise<{ stdout?: string; stderr?: string }>;

export type GithubDelegatedCliOptions = {
  execFile?: ExecFile;
  timeoutMs?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
};

const HOST = "github.com" as const;
const DEFAULT_TIMEOUT_MS = 8_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const AUTH_MAX_OUTPUT_BYTES = 64 * 1024;
const LOGIN_MAX_LENGTH = 128;
const FIELD_MAX_LENGTH = 1_024;
const BODY_MAX_LENGTH = 65_536;
const PAGE_SIZE = 30;
const MAX_PAGE = 1_000;
const MAX_INBOX_PAGES = 4;
const MAX_REVIEW_COMMENTS = 100;
const MAX_COMMENT_BODY_LENGTH = 20_480;
const MAX_AGGREGATE_TEXT_LENGTH = 96 * 1024;

const defaultExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    const maxBuffer = Number(options.maxBuffer);
    const timeout = Number(options.timeout);
    const child = spawn(file, args, {
      cwd: String(options.cwd),
      env: options.env as NodeJS.ProcessEnv,
      windowsHide: options.windowsHide === true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let total = 0;
    let settled = false;
    let timedOut = false;
    const finishError = (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.once("error", (error) => finishError(error));
    child.stdin.on("error", () => undefined);
    for (const [stream, target] of [
      [child.stdout, stdout],
      [child.stderr, stderr]
    ] as const) {
      stream.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > maxBuffer) {
          child.kill();
          finishError(
            Object.assign(new Error("output exceeded bound"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            })
          );
          return;
        }
        target.push(chunk);
      });
    }
    child.once("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        finishError(
          Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" })
        );
        return;
      }
      clearTimeout(timer);
      settled = true;
      if (code !== 0) {
        const errorText = Buffer.concat(stderr).toString("utf8");
        const providerCode =
          /API rate limit exceeded|secondary rate limit|HTTP 429/i.test(
            errorText
          )
            ? "GH_RATE_LIMITED"
            : /HTTP 401|Bad credentials|authentication token/i.test(errorText)
              ? "GH_AUTH_REJECTED"
              : /HTTP 403/i.test(errorText)
                ? "GH_FORBIDDEN"
                : /HTTP 404/i.test(errorText)
                  ? "GH_NOT_FOUND"
                  : /HTTP 5\d\d/i.test(errorText)
                    ? "GH_UNAVAILABLE"
                    : "GH_EXIT";
        reject(
          Object.assign(new Error("gh operation failed"), {
            code: providerCode,
            signal
          })
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    if (typeof options.input === "string")
      child.stdin.end(options.input, "utf8");
    else child.stdin.end();
  });

const githubError = (code: string) => Object.assign(new Error(code), { code });

const sanitizeEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith("GIT_") ||
      normalized === "GH_TOKEN" ||
      normalized === "GITHUB_TOKEN" ||
      normalized === "GH_ENTERPRISE_TOKEN" ||
      normalized === "GH_HOST" ||
      normalized === "GH_CONFIG_DIR" ||
      normalized === "GH_REPO" ||
      /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|BEARER|PRIVATE_KEY)/.test(
        normalized
      )
    )
      continue;
    result[key] = value;
  }
  result.HOME = homedir();
  return result;
};

const checkedText = (
  value: unknown,
  maximum: number,
  code: string,
  { allowEmpty = false } = {}
) => {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw githubError(code);
  return value;
};

const validLogin = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= LOGIN_MAX_LENGTH &&
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);

const validRepository = (value: unknown) => {
  if (typeof value !== "string" || value.length > 201) return null;
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (!match) return null;
  const owner = match[1];
  const name = match[2];
  if (!owner || !name) return null;
  if (
    owner.length > 100 ||
    name.length > 100 ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name)
  )
    return null;
  return { owner, name, fullName: `${owner}/${name}` };
};

const parsePage = (value: unknown) => {
  const page = Number(value ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE)
    throw githubError("github_invalid_page");
  return page;
};

const parseObject = (stdout: string, maximum: number) => {
  if (Buffer.byteLength(stdout, "utf8") > maximum)
    throw githubError("github_response_too_large");
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw githubError("github_read_invalid");
  }
};

const toReview = (value: unknown) => {
  const review = value as Record<string, unknown> | null;
  const id = review?.id;
  const user = review?.user as Record<string, unknown> | null;
  const author = user?.login;
  const commitId = review?.commit_id;
  const state = review?.state;
  const submittedAt = review?.submitted_at;
  const body = review?.body;
  const url = review?.html_url;
  if (
    !Number.isSafeInteger(id) ||
    Number(id) < 1 ||
    !validLogin(author) ||
    typeof commitId !== "string" ||
    commitId.length > 128 ||
    typeof state !== "string" ||
    state.length > 64 ||
    (submittedAt !== null && typeof submittedAt !== "string") ||
    (body !== null && typeof body !== "string") ||
    (url !== null && typeof url !== "string")
  )
    throw githubError("github_read_invalid");
  const sourceBody = typeof body === "string" ? body : "";
  const event =
    state === "APPROVED"
      ? "APPROVE"
      : state === "CHANGES_REQUESTED"
        ? "REQUEST_CHANGES"
        : state === "COMMENTED"
          ? "COMMENT"
          : null;
  return {
    id: Number(id),
    author,
    commitId,
    state,
    event,
    submittedAt: typeof submittedAt === "string" ? submittedAt : null,
    body: sourceBody.slice(0, BODY_MAX_LENGTH),
    bodyTruncated: sourceBody.length > BODY_MAX_LENGTH,
    url: typeof url === "string" ? url : null
  };
};

export type GithubInboxItem = {
  repository: string;
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  url: string;
  origin: "requested_review" | "authored" | "authored_and_requested_review";
};

const mapSearchPullRequest = (
  value: unknown,
  origin: "requested_review" | "authored"
): GithubInboxItem => {
  const item = value as Record<string, unknown> | null;
  const repo = item?.repository_url;
  const repository =
    typeof repo === "string"
      ? /\/repos\/([^/]+\/[^/]+)$/.exec(repo)?.[1]
      : null;
  const fullName = repository ? validRepository(repository)?.fullName : null;
  const user = item?.user as Record<string, unknown> | null;
  if (
    !fullName ||
    !Number.isSafeInteger(item?.number) ||
    Number(item?.number) < 1 ||
    typeof item?.title !== "string" ||
    item.title.length > FIELD_MAX_LENGTH ||
    !validLogin(user?.login) ||
    typeof item?.updated_at !== "string" ||
    item.updated_at.length > FIELD_MAX_LENGTH ||
    typeof item?.html_url !== "string" ||
    !item.html_url.startsWith("https://github.com/")
  )
    throw githubError("github_read_invalid");
  return {
    repository: fullName,
    number: Number(item.number),
    title: item.title,
    author: user.login,
    updatedAt: item.updated_at,
    url: item.html_url,
    origin
  };
};

const validateReviewInput = (input: unknown) => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw githubError("github_invalid_review");
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "repo",
    "number",
    "expectedHeadSha",
    "expectedAccountLogin",
    "commitId",
    "event",
    "body",
    "comments"
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw githubError("github_invalid_review");
  const repository = validRepository(record.repo);
  const number = record.number;
  const expectedHeadSha = record.expectedHeadSha;
  const commitId = record.commitId;
  if (
    !repository ||
    !Number.isSafeInteger(number) ||
    Number(number) < 1 ||
    typeof expectedHeadSha !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(expectedHeadSha) ||
    typeof commitId !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(commitId) ||
    commitId.toLocaleLowerCase() !== expectedHeadSha.toLocaleLowerCase() ||
    !validLogin(record.expectedAccountLogin) ||
    !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(String(record.event))
  )
    throw githubError("github_invalid_review");
  const body = checkedText(
    record.body,
    BODY_MAX_LENGTH,
    "github_invalid_review",
    {
      allowEmpty: true
    }
  );
  if (
    !Array.isArray(record.comments) ||
    record.comments.length > MAX_REVIEW_COMMENTS
  )
    throw githubError("github_invalid_review");
  const comments = record.comments.map((comment) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment))
      throw githubError("github_invalid_review");
    const value = comment as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["path", "line", "side", "body"].includes(key)
      )
    )
      throw githubError("github_invalid_review");
    const path = checkedText(value.path, 2_048, "github_invalid_review");
    const line = value.line;
    const side = value.side;
    const inlineBody = checkedText(
      value.body,
      MAX_COMMENT_BODY_LENGTH,
      "github_invalid_review"
    );
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === ".") ||
      !Number.isSafeInteger(line) ||
      Number(line) < 1 ||
      Number(line) > 10_000_000 ||
      (side !== "LEFT" && side !== "RIGHT")
    )
      throw githubError("github_invalid_review");
    return { path, line: Number(line), side, body: inlineBody };
  });
  if (!body && comments.length === 0)
    throw githubError("github_invalid_review");
  return {
    repository,
    number: Number(number),
    expectedHeadSha,
    expectedAccountLogin: record.expectedAccountLogin,
    commitId,
    event: record.event as GithubReviewEvent,
    body,
    comments
  };
};

export const createGithubDelegatedCli = ({
  execFile = defaultExecFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  environment = process.env
}: GithubDelegatedCliOptions = {}) => {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw githubError("github_invalid_configuration");
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 8 * 1024 * 1024
  )
    throw githubError("github_invalid_configuration");
  const safeEnvironment = sanitizeEnvironment(environment);

  const run = async (
    args: string[],
    {
      timeout = timeoutMs,
      maxBytes = maxOutputBytes,
      input,
      mutation = false
    }: {
      timeout?: number;
      maxBytes?: number;
      input?: string;
      mutation?: boolean;
    } = {}
  ) => {
    try {
      const result = await execFile("gh", args, {
        encoding: "utf8",
        timeout,
        maxBuffer: maxBytes,
        cwd: homedir(),
        windowsHide: true,
        env: { ...safeEnvironment },
        ...(input === undefined ? {} : { input })
      });
      const stdout = typeof result?.stdout === "string" ? result.stdout : "";
      if (Buffer.byteLength(stdout, "utf8") > maxBytes)
        throw githubError("github_response_too_large");
      return stdout;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (mutation && code !== "ENOENT")
        throw githubError("github_publication_uncertain");
      if (code === "github_response_too_large") throw error;
      if (code === "ENOENT") throw githubError("github_cli_missing");
      if (code === "GH_RATE_LIMITED") throw githubError("github_rate_limited");
      if (code === "GH_AUTH_REJECTED")
        throw githubError("github_read_rejected");
      if (code === "GH_FORBIDDEN" || code === "GH_NOT_FOUND")
        throw githubError("github_read_forbidden");
      if (code === "GH_UNAVAILABLE")
        throw githubError("github_read_unavailable");
      if (code === "ETIMEDOUT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw githubError(
          code === "ETIMEDOUT"
            ? "github_read_timeout"
            : "github_response_too_large"
        );
      throw githubError("github_cli_operation_failed");
    }
  };

  const readAccounts = async (): Promise<GithubAccount[]> => {
    const stdout = await run(
      ["auth", "status", "--hostname", HOST, "--json", "hosts"],
      { maxBytes: AUTH_MAX_OUTPUT_BYTES }
    );
    const payload = parseObject(stdout, AUTH_MAX_OUTPUT_BYTES) as {
      hosts?: Record<string, unknown>;
    };
    const hostAccounts = payload?.hosts?.[HOST];
    if (hostAccounts === undefined) return [];
    if (!Array.isArray(hostAccounts) || hostAccounts.length > 20)
      throw githubError("github_read_invalid");
    const seen = new Set<string>();
    return hostAccounts.map((entry) => {
      const account = entry as Record<string, unknown>;
      const login = account?.login;
      const key = typeof login === "string" ? login.toLocaleLowerCase() : "";
      if (
        !validLogin(login) ||
        typeof account.active !== "boolean" ||
        (account.state !== "success" && account.state !== "error") ||
        seen.has(key)
      )
        throw githubError("github_read_invalid");
      seen.add(key);
      return {
        host: HOST,
        login,
        active: account.active,
        state: account.state
      };
    });
  };

  const readIdentity = async (expectedAccountLogin?: string) => {
    if (expectedAccountLogin !== undefined && !validLogin(expectedAccountLogin))
      throw githubError("github_invalid_account");
    const stdout = await run(
      ["api", "--hostname", HOST, "user", "--jq", "{id:.id,login:.login}"],
      { maxBytes: AUTH_MAX_OUTPUT_BYTES }
    );
    const identity = parseObject(stdout, AUTH_MAX_OUTPUT_BYTES) as {
      id?: unknown;
      login?: unknown;
    };
    if (
      !(
        typeof identity?.id === "number" &&
        Number.isSafeInteger(identity.id) &&
        identity.id > 0
      ) ||
      !validLogin(identity?.login)
    )
      throw githubError("github_identity_invalid");
    if (
      typeof expectedAccountLogin === "string" &&
      identity.login.toLocaleLowerCase() !==
        expectedAccountLogin.toLocaleLowerCase()
    )
      throw githubError("github_account_changed");
    return { id: String(identity.id), login: identity.login };
  };

  const assertIdentity = async (expectedAccountLogin: unknown) => {
    if (!validLogin(expectedAccountLogin))
      throw githubError("github_invalid_account");
    return (await readIdentity(expectedAccountLogin)).login;
  };

  const readApi = async (path: string, expectedAccountLogin: unknown) => {
    await assertIdentity(expectedAccountLogin);
    const stdout = await run(["api", "--hostname", HOST, path]);
    const payload = parseObject(stdout, maxOutputBytes);
    await assertIdentity(expectedAccountLogin);
    return payload;
  };

  const discoverAccounts = async () => readAccounts();

  const getActiveAccount = async () => {
    const accounts = await readAccounts();
    const active = accounts.filter(
      (account) => account.active && account.state === "success"
    );
    if (active.length !== 1)
      throw githubError(
        active.length ? "github_read_invalid" : "github_not_connected"
      );
    const account = active[0];
    if (!account) throw githubError("github_not_connected");
    const identity = await readIdentity(account.login);
    return { ...account, ...identity };
  };

  const selectAccount = async ({ login }: { login: unknown }) => {
    if (!validLogin(login)) throw githubError("github_invalid_account");
    const accounts = await readAccounts();
    const account = accounts.find(
      (candidate) =>
        candidate.login.toLocaleLowerCase() === login.toLocaleLowerCase()
    );
    if (!account || account.state !== "success")
      throw githubError("github_account_unavailable");
    await run(["auth", "switch", "--hostname", HOST, "--user", account.login], {
      maxBytes: AUTH_MAX_OUTPUT_BYTES
    });
    const afterSwitch = await readAccounts();
    const selected = afterSwitch.find(
      (candidate) =>
        candidate.login.toLocaleLowerCase() ===
        account.login.toLocaleLowerCase()
    );
    if (!selected?.active || selected.state !== "success")
      throw githubError("github_account_changed");
    const identity = await readIdentity(selected.login);
    return { ...selected, ...identity };
  };

  const beginBrowserSignIn = async () => {
    await run(
      ["auth", "login", "--hostname", HOST, "--web", "--git-protocol", "https"],
      {
        timeout: LOGIN_TIMEOUT_MS,
        maxBytes: AUTH_MAX_OUTPUT_BYTES
      }
    );
    return getActiveAccount();
  };

  const readRepositories = async ({
    expectedAccountLogin,
    page = 1
  }: {
    expectedAccountLogin: string;
    page?: number;
  }) => {
    const pageNumber = parsePage(page);
    const payload = await readApi(
      `user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&direction=desc&page=${pageNumber}&per_page=${PAGE_SIZE}&sort=updated`,
      expectedAccountLogin
    );
    if (!Array.isArray(payload)) throw githubError("github_read_invalid");
    const repositories = payload.slice(0, PAGE_SIZE).map((repo) => {
      const value = repo as Record<string, unknown>;
      const parsed = validRepository(value?.full_name);
      if (
        !parsed ||
        !(typeof value.id === "string" || typeof value.id === "number") ||
        typeof value.private !== "boolean"
      )
        throw githubError("github_read_invalid");
      return {
        id: value.id,
        fullName: parsed.fullName,
        private: value.private
      };
    });
    return {
      repositories,
      hasMore: payload.length >= PAGE_SIZE,
      page: pageNumber
    };
  };

  const readRepository = async ({
    expectedAccountLogin,
    repo
  }: {
    expectedAccountLogin: string;
    repo: string;
  }) => {
    const parsed = validRepository(repo);
    if (!parsed) throw githubError("github_invalid_repository");
    const payload = (await readApi(
      `repos/${parsed.owner}/${parsed.name}`,
      expectedAccountLogin
    )) as Record<string, unknown>;
    const fullName = validRepository(payload?.full_name);
    if (
      !fullName ||
      !(typeof payload.id === "number" || typeof payload.id === "string") ||
      typeof payload.private !== "boolean"
    )
      throw githubError("github_read_invalid");
    const rawPermissions = payload.permissions;
    const permissions =
      rawPermissions &&
      typeof rawPermissions === "object" &&
      !Array.isArray(rawPermissions)
        ? Object.fromEntries(
            ["pull", "push", "admin"].map((key) => [
              key,
              (rawPermissions as Record<string, unknown>)[key] === true
            ])
          )
        : null;
    return {
      id: String(payload.id),
      fullName: fullName.fullName,
      private: payload.private,
      permissions
    };
  };

  const readPullRequests = async ({
    expectedAccountLogin,
    repo,
    repository,
    page = 1
  }: {
    expectedAccountLogin: string;
    repo?: string;
    repository?: string;
    page?: number;
  }) => {
    const pageNumber = parsePage(page);
    const parsed = validRepository(repo ?? repository);
    if (!parsed) throw githubError("github_invalid_repository");
    const payload = await readApi(
      `repos/${parsed.owner}/${parsed.name}/pulls?direction=desc&page=${pageNumber}&per_page=${PAGE_SIZE}&sort=updated&state=all`,
      expectedAccountLogin
    );
    if (!Array.isArray(payload)) throw githubError("github_read_invalid");
    const pullRequests = payload
      .slice(0, PAGE_SIZE)
      .map((entry) => mapPullRequest(entry));
    return {
      pullRequests,
      hasMore: payload.length >= PAGE_SIZE,
      page: pageNumber
    };
  };

  const readPullRequest = async ({
    expectedAccountLogin,
    repo,
    repository,
    number
  }: {
    expectedAccountLogin: string;
    repo?: string;
    repository?: string;
    number: number;
  }) => {
    const parsed = validRepository(repo ?? repository);
    const pullNumber = Number(number);
    if (
      !parsed ||
      !Number.isSafeInteger(pullNumber) ||
      pullNumber < 1 ||
      pullNumber > 2 ** 31 - 1
    )
      throw githubError("github_invalid_pull_request");
    const base = `repos/${parsed.owner}/${parsed.name}/pulls/${pullNumber}`;
    const payload = (await readApi(base, expectedAccountLogin)) as Record<
      string,
      unknown
    >;
    const pullRequest = mapPullRequest(payload, {
      detail: true,
      requestedNumber: pullNumber
    });
    const [
      issueCommentsPayload,
      reviewCommentsPayload,
      reviewsPayload,
      checksPayload
    ] = await Promise.all([
      readApi(
        `repos/${parsed.owner}/${parsed.name}/issues/${pullNumber}/comments?per_page=${PAGE_SIZE}&page=1`,
        expectedAccountLogin
      ),
      readApi(
        `${base}/comments?per_page=${PAGE_SIZE}&page=1`,
        expectedAccountLogin
      ),
      readApi(
        `${base}/reviews?per_page=${PAGE_SIZE}&page=1`,
        expectedAccountLogin
      ),
      readApi(
        `repos/${parsed.owner}/${parsed.name}/commits/${pullRequest.headSha}/check-runs?per_page=${PAGE_SIZE}&page=1`,
        expectedAccountLogin
      )
    ]);
    const issueComments = mapComments(
      issueCommentsPayload,
      "github_read_invalid"
    );
    const reviewComments = mapComments(
      reviewCommentsPayload,
      "github_read_invalid"
    );
    const reviews = mapReviews(reviewsPayload);
    const checks = mapChecks(checksPayload);
    const textBudget = { remaining: MAX_AGGREGATE_TEXT_LENGTH };
    const boundedIssueComments = issueComments.items.map((entry) =>
      boundComment(entry, textBudget)
    );
    const boundedReviewComments = reviewComments.items.map((entry) =>
      boundComment(entry, textBudget)
    );
    const boundedReviews = reviews.items.map((entry) => {
      const body = entry.body.slice(0, textBudget.remaining);
      textBudget.remaining -= body.length;
      return {
        ...entry,
        body,
        bodyTruncated: entry.bodyTruncated || body.length < entry.body.length
      };
    });
    return {
      pullRequest,
      comments: boundedIssueComments,
      commentsTruncated:
        issueComments.hasMore ||
        (Number(payload.comments) || 0) > issueComments.items.length,
      reviewComments: boundedReviewComments,
      reviewCommentsTruncated:
        reviewComments.hasMore ||
        (Number(payload.review_comments) || 0) > reviewComments.items.length,
      reviews: boundedReviews,
      reviewsTruncated: reviews.hasMore,
      checks: checks.items,
      checksTruncated: checks.hasMore
    };
  };

  const readPullRequestContext = async ({
    expectedAccountLogin,
    repo,
    number
  }: {
    expectedAccountLogin: string;
    repo: string;
    number: number;
  }) => {
    const parsed = validRepository(repo);
    if (
      !parsed ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 2 ** 31 - 1
    )
      throw githubError("github_invalid_pull_request");
    const path = `repos/${parsed.owner}/${parsed.name}/pulls/${number}`;
    const readHead = async () =>
      mapPullRequest(await readApi(path, expectedAccountLogin), {
        detail: true,
        requestedNumber: number
      });
    const pullRequest = await readHead();
    const filesPayload = await readApi(
      `${path}/files?per_page=${PAGE_SIZE}&page=1`,
      expectedAccountLogin
    );
    if (!Array.isArray(filesPayload)) throw githubError("github_read_invalid");
    let budget = 96 * 1024;
    const files = filesPayload.slice(0, PAGE_SIZE).map((entry) => {
      const file = entry as Record<string, unknown>;
      if (typeof file.filename !== "string" || file.filename.length > 2_048)
        throw githubError("github_read_invalid");
      const source = typeof file.patch === "string" ? file.patch : "";
      const patch = source.slice(0, Math.min(16 * 1024, budget));
      budget -= patch.length;
      return {
        path: file.filename,
        status:
          typeof file.status === "string"
            ? file.status.slice(0, FIELD_MAX_LENGTH)
            : "",
        additions: Number.isSafeInteger(file.additions)
          ? Number(file.additions)
          : null,
        deletions: Number.isSafeInteger(file.deletions)
          ? Number(file.deletions)
          : null,
        patch,
        patchTruncated: patch.length < source.length,
        patchUnavailable: typeof file.patch !== "string"
      };
    });
    const latest = await readHead();
    if (
      latest.headSha !== pullRequest.headSha ||
      latest.baseSha !== pullRequest.baseSha
    )
      throw githubError("github_context_changed");
    return {
      pullRequest,
      files,
      filesTruncated:
        Number(pullRequest.changedFiles) > files.length ||
        filesPayload.length >= PAGE_SIZE
    };
  };

  const readInbox = async ({
    expectedAccountLogin,
    page = 1,
    maxPages = 1
  }: {
    expectedAccountLogin: string;
    page?: number;
    maxPages?: number;
  }) => {
    const startPage = parsePage(page);
    if (
      !Number.isInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > MAX_INBOX_PAGES
    )
      throw githubError("github_invalid_page");
    const byKey = new Map<string, GithubInboxItem>();
    let requestedIncomplete = false;
    let authoredIncomplete = false;
    let requestedHasMore = false;
    let authoredHasMore = false;
    for (let offset = 0; offset < maxPages; offset += 1) {
      const currentPage = startPage + offset;
      if (currentPage > MAX_PAGE) throw githubError("github_invalid_page");
      const [requestedPayload, authoredPayload] = await Promise.all([
        readApi(
          `search/issues?q=is%3Apr+is%3Aopen+review-requested%3A%40me&per_page=${PAGE_SIZE}&page=${currentPage}`,
          expectedAccountLogin
        ),
        readApi(
          `search/issues?q=is%3Apr+is%3Aopen+author%3A%40me&per_page=${PAGE_SIZE}&page=${currentPage}`,
          expectedAccountLogin
        )
      ]);
      const mapSearchResult = (
        payload: unknown,
        origin: "requested_review" | "authored"
      ) => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw githubError("github_read_invalid");
        const value = payload as Record<string, unknown>;
        if (
          !Array.isArray(value.items) ||
          value.items.length > PAGE_SIZE ||
          typeof value.incomplete_results !== "boolean" ||
          !Number.isSafeInteger(value.total_count)
        )
          throw githubError("github_read_invalid");
        if (origin === "requested_review") {
          requestedIncomplete ||= value.incomplete_results;
          requestedHasMore =
            Number(value.total_count) > currentPage * PAGE_SIZE;
        } else {
          authoredIncomplete ||= value.incomplete_results;
          authoredHasMore = Number(value.total_count) > currentPage * PAGE_SIZE;
        }
        return value.items.map((item) => mapSearchPullRequest(item, origin));
      };
      for (const item of mapSearchResult(
        requestedPayload,
        "requested_review"
      )) {
        const key = `${item.repository.toLocaleLowerCase()}#${item.number}`;
        byKey.set(key, { ...item, origin: "requested_review" });
      }
      for (const item of mapSearchResult(authoredPayload, "authored")) {
        const key = `${item.repository.toLocaleLowerCase()}#${item.number}`;
        const existing = byKey.get(key);
        if (existing) existing.origin = "authored_and_requested_review";
        else byKey.set(key, item);
      }
    }
    const items = [...byKey.values()].slice(0, PAGE_SIZE * maxPages);
    const truncated =
      requestedHasMore ||
      authoredHasMore ||
      requestedIncomplete ||
      authoredIncomplete ||
      byKey.size > items.length;
    return {
      items,
      hasMore: truncated,
      truncated,
      page: startPage,
      pagesRead: maxPages,
      teamRequestsIncluded: false,
      limitation:
        "GitHub search does not enumerate team-review requests for the current user globally."
    };
  };

  const publishReview = async (input: unknown) => {
    const value = validateReviewInput(input);
    await assertIdentity(value.expectedAccountLogin);
    const base = `repos/${value.repository.owner}/${value.repository.name}/pulls/${value.number}`;
    const current = (await readApi(base, value.expectedAccountLogin)) as Record<
      string,
      unknown
    >;
    const currentHead = (current?.head as Record<string, unknown> | null)?.sha;
    if (currentHead !== value.expectedHeadSha)
      throw githubError("github_head_changed");
    const args = [
      "api",
      "--hostname",
      HOST,
      `${base}/reviews`,
      "--method",
      "POST",
      "--input",
      "-"
    ];
    const requestBody = JSON.stringify({
      event: value.event,
      commit_id: value.commitId,
      body: value.body,
      comments: value.comments
    });
    if (Buffer.byteLength(requestBody, "utf8") > 2 * 1024 * 1024)
      throw githubError("github_invalid_review");
    const stdout = await run(args, { input: requestBody, mutation: true });
    let payload: unknown;
    try {
      payload = parseObject(stdout, maxOutputBytes);
      await assertIdentity(value.expectedAccountLogin);
    } catch {
      throw githubError("github_publication_uncertain");
    }
    try {
      return { review: toReview(payload) };
    } catch {
      throw githubError("github_publication_uncertain");
    }
  };

  const readPublishedReview = async ({
    expectedAccountLogin,
    repo,
    number,
    reviewId,
    page = 1
  }: {
    expectedAccountLogin: string;
    repo: string;
    number: number;
    reviewId?: number;
    page?: number;
  }) => {
    const parsed = validRepository(repo);
    const pullNumber = Number(number);
    if (
      !parsed ||
      !Number.isSafeInteger(pullNumber) ||
      pullNumber < 1 ||
      pullNumber > 2 ** 31 - 1
    )
      throw githubError("github_invalid_pull_request");
    if (reviewId !== undefined) {
      if (!Number.isSafeInteger(reviewId) || reviewId < 1)
        throw githubError("github_invalid_review");
      return {
        review: toReview(
          await readApi(
            `repos/${parsed.owner}/${parsed.name}/pulls/${pullNumber}/reviews/${reviewId}`,
            expectedAccountLogin
          )
        ),
        hasMore: false
      };
    }
    const pageNumber = parsePage(page);
    const payload = await readApi(
      `repos/${parsed.owner}/${parsed.name}/pulls/${pullNumber}/reviews?per_page=${PAGE_SIZE}&page=${pageNumber}`,
      expectedAccountLogin
    );
    if (!Array.isArray(payload)) throw githubError("github_read_invalid");
    const reviews = payload.slice(0, PAGE_SIZE).map(toReview);
    return { reviews, hasMore: payload.length >= PAGE_SIZE, page: pageNumber };
  };

  const readPublishedReviewComments = async ({
    expectedAccountLogin,
    repo,
    number,
    reviewId,
    page = 1
  }: {
    expectedAccountLogin: string;
    repo: string;
    number: number;
    reviewId: number;
    page?: number;
  }) => {
    const parsed = validRepository(repo);
    const pullNumber = Number(number);
    if (
      !parsed ||
      !Number.isSafeInteger(pullNumber) ||
      pullNumber < 1 ||
      pullNumber > 2 ** 31 - 1 ||
      !Number.isSafeInteger(reviewId) ||
      reviewId < 1
    )
      throw githubError("github_invalid_review");
    const pageNumber = parsePage(page);
    const payload = await readApi(
      `repos/${parsed.owner}/${parsed.name}/pulls/${pullNumber}/reviews/${reviewId}/comments?per_page=${PAGE_SIZE}&page=${pageNumber}`,
      expectedAccountLogin
    );
    if (!Array.isArray(payload)) throw githubError("github_read_invalid");
    const comments = payload.slice(0, PAGE_SIZE).map((entry) => {
      const value = entry as Record<string, unknown>;
      const line = value.line ?? value.original_line;
      const side = value.side ?? value.original_side;
      if (
        typeof value.path !== "string" ||
        !value.path ||
        value.path.length > 2_048 ||
        !Number.isSafeInteger(line) ||
        Number(line) < 1 ||
        (side !== "LEFT" && side !== "RIGHT") ||
        typeof value.body !== "string"
      )
        throw githubError("github_read_invalid");
      return {
        path: value.path,
        line: Number(line),
        side,
        body: value.body.slice(0, MAX_COMMENT_BODY_LENGTH),
        bodyTruncated: value.body.length > MAX_COMMENT_BODY_LENGTH
      };
    });
    return {
      comments,
      hasMore: payload.length >= PAGE_SIZE,
      bodyTruncated: comments.some((comment) => comment.bodyTruncated),
      page: pageNumber
    };
  };

  return Object.freeze({
    discoverAccounts,
    getActiveAccount,
    readIdentity,
    selectAccount,
    beginBrowserSignIn,
    readRepositories,
    readRepository,
    readPullRequests,
    readPullRequest,
    readPullRequestContext,
    readInbox,
    publishReview,
    readPublishedReview,
    readPublishedReviewComments
  });
};

const mapPullRequest = (
  payload: unknown,
  {
    detail = false,
    requestedNumber = null
  }: { detail?: boolean; requestedNumber?: number | null } = {}
) => {
  const value = payload as Record<string, unknown> | null;
  const user = value?.user as Record<string, unknown> | null;
  const head = value?.head as Record<string, unknown> | null;
  const base = value?.base as Record<string, unknown> | null;
  const number = value?.number;
  const title = value?.title;
  const author = user?.login;
  const headSha = head?.sha;
  const baseSha = base?.sha;
  const headBranch = head?.ref;
  const baseBranch = base?.ref;
  const headRepoPayload = head?.repo as Record<string, unknown> | null;
  const baseRepoPayload = base?.repo as Record<string, unknown> | null;
  const updatedAt = value?.updated_at;
  const url = value?.html_url;
  if (
    !Number.isSafeInteger(number) ||
    Number(number) < 1 ||
    (requestedNumber !== null && number !== requestedNumber) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > FIELD_MAX_LENGTH ||
    (value?.state !== "open" && value?.state !== "closed") ||
    !validLogin(author) ||
    typeof headSha !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(headSha) ||
    typeof baseSha !== "string" ||
    !/^[a-f0-9]{40,64}$/i.test(baseSha) ||
    typeof headBranch !== "string" ||
    headBranch.length > FIELD_MAX_LENGTH ||
    typeof baseBranch !== "string" ||
    baseBranch.length > FIELD_MAX_LENGTH ||
    typeof updatedAt !== "string" ||
    updatedAt.length > FIELD_MAX_LENGTH ||
    typeof url !== "string" ||
    !url.startsWith("https://github.com/")
  )
    throw githubError("github_read_invalid");
  const reviewers = Array.isArray(value?.requested_reviewers)
    ? value.requested_reviewers.flatMap((entry) => {
        const login = (entry as Record<string, unknown> | null)?.login;
        return validLogin(login) ? [login] : [];
      })
    : [];
  const repositoryBrief = (repo: Record<string, unknown> | null) => {
    if (!repo) return null;
    const name = validRepository(repo.full_name);
    if (!name || !(typeof repo.id === "number" || typeof repo.id === "string"))
      throw githubError("github_read_invalid");
    return { id: String(repo.id), fullName: name.fullName };
  };
  const headRepository = repositoryBrief(headRepoPayload);
  const baseRepository = repositoryBrief(baseRepoPayload);
  const result: Record<string, unknown> = {
    number: Number(number),
    title,
    state: value.state,
    draft: value.draft === true,
    merged: value.merged === true || Boolean(value.merged_at),
    author,
    requestedReviewers: [...new Set(reviewers)],
    headSha,
    baseSha,
    headBranch,
    baseBranch,
    headRepository,
    baseRepository,
    headRepositoryId: headRepository?.id ?? null,
    baseRepositoryId: baseRepository?.id ?? null,
    updatedAt,
    url
  };
  if (detail) {
    if (
      (value?.body !== null && typeof value?.body !== "string") ||
      !Number.isSafeInteger(value?.additions) ||
      Number(value?.additions) < 0 ||
      !Number.isSafeInteger(value?.deletions) ||
      Number(value?.deletions) < 0 ||
      !Number.isSafeInteger(value?.changed_files) ||
      Number(value?.changed_files) < 0
    )
      throw githubError("github_read_invalid");
    const body = typeof value.body === "string" ? value.body : "";
    result.body = body.slice(0, BODY_MAX_LENGTH);
    result.bodyTruncated = body.length > BODY_MAX_LENGTH;
    result.additions = Number(value.additions);
    result.deletions = Number(value.deletions);
    result.changedFiles = Number(value.changed_files);
  }
  return result;
};

const mapComments = (payload: unknown, errorCode: string) => {
  if (!Array.isArray(payload)) throw githubError(errorCode);
  const items = payload.slice(0, PAGE_SIZE).map((entry) => {
    const value = entry as Record<string, unknown>;
    const user = value?.user as Record<string, unknown> | null;
    if (
      !Number.isSafeInteger(value?.id) ||
      Number(value.id) < 1 ||
      !validLogin(user?.login) ||
      typeof value.body !== "string" ||
      typeof value.created_at !== "string" ||
      (value.html_url !== null && typeof value.html_url !== "string")
    )
      throw githubError(errorCode);
    return {
      id: Number(value.id),
      author: user.login,
      body: value.body.slice(0, MAX_AGGREGATE_TEXT_LENGTH),
      bodyTruncated: value.body.length > MAX_AGGREGATE_TEXT_LENGTH,
      createdAt: value.created_at,
      url: typeof value.html_url === "string" ? value.html_url : null
    };
  });
  return { items, hasMore: payload.length >= PAGE_SIZE };
};

const mapReviews = (payload: unknown) => {
  if (!Array.isArray(payload)) throw githubError("github_read_invalid");
  return {
    items: payload.slice(0, PAGE_SIZE).map(toReview),
    hasMore: payload.length >= PAGE_SIZE
  };
};

const mapChecks = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw githubError("github_read_invalid");
  const value = payload as Record<string, unknown>;
  if (
    !Array.isArray(value.check_runs) ||
    !Number.isSafeInteger(value.total_count)
  )
    throw githubError("github_read_invalid");
  const items = value.check_runs.slice(0, PAGE_SIZE).map((entry) => {
    const check = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(check?.id) ||
      Number(check.id) < 1 ||
      typeof check.name !== "string" ||
      typeof check.status !== "string" ||
      (check.conclusion !== null && typeof check.conclusion !== "string") ||
      (check.html_url !== null && typeof check.html_url !== "string")
    )
      throw githubError("github_read_invalid");
    return {
      id: Number(check.id),
      name: check.name.slice(0, FIELD_MAX_LENGTH),
      state: check.status,
      conclusion:
        typeof check.conclusion === "string" ? check.conclusion : null,
      url: typeof check.html_url === "string" ? check.html_url : null
    };
  });
  return {
    items,
    hasMore:
      Number(value.total_count) > items.length ||
      value.check_runs.length >= PAGE_SIZE
  };
};

const boundComment = <T extends { body: string; bodyTruncated: boolean }>(
  comment: T,
  budget: { remaining: number }
) => {
  const body = comment.body.slice(0, Math.max(0, budget.remaining));
  budget.remaining -= body.length;
  return {
    ...comment,
    body,
    bodyTruncated: comment.bodyTruncated || body.length < comment.body.length
  };
};

export const githubDelegatedConstants = Object.freeze({
  host: HOST,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  defaultMaxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  pageSize: PAGE_SIZE,
  maxInboxPages: MAX_INBOX_PAGES,
  maxReviewComments: MAX_REVIEW_COMMENTS
});
