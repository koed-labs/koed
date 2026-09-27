import { execFile as nodeExecFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";

const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_API_BASE = "https://api.github.com";
const GH_TIMEOUT_MS = 8_000;
const GH_MAX_BUFFER = 64 * 1024;
const GITHUB_RESPONSE_MAX_BYTES = 64 * 1024;
const GITHUB_READ_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const GITHUB_PAGE_SIZE = 30;
const GITHUB_MAX_PAGE = 1_000;
const LOGIN_MAX_LENGTH = 128;
const REPOSITORY_PART_MAX_LENGTH = 100;
const MAX_FIELD_LENGTH = 1_024;
const MAX_BODY_LENGTH = 32 * 1_024;

const defaultExecFile = promisify(nodeExecFile);

const capabilities = Object.freeze({
  readPullRequests: false,
  publishReviews: false
});
const connectedCapabilities = Object.freeze({
  readPullRequests: true,
  publishReviews: false
});

const disconnectedStatus = () => ({
  state: "disconnected",
  login: null,
  message: null,
  capabilities: { ...capabilities }
});

const errorStatus = (message) => ({
  state: "error",
  login: null,
  message,
  capabilities: { ...capabilities }
});

const connectedStatus = (login) => ({
  state: "connected",
  login,
  message: null,
  capabilities: { ...connectedCapabilities }
});

const isAbortError = (error) =>
  error?.name === "AbortError" || error?.code === "ABORT_ERR";

const isRateLimitedResponse = (response) => {
  const remaining = response?.headers?.get?.("x-ratelimit-remaining");
  const retryAfter = response?.headers?.get?.("retry-after");
  return (
    response?.status === 429 ||
    remaining === "0" ||
    (typeof retryAfter === "string" && retryAfter.length > 0)
  );
};

const readBoundedJson = async (
  response,
  maxBytes = GITHUB_RESPONSE_MAX_BYTES
) => {
  const contentLength = Number(response.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    throw new Error("github_response_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new Error("github_response_too_large");
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("github_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return JSON.parse(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")
  );
};

const readGithubIdentity = async (fetchImpl, token) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "Koed Studio"
      },
      redirect: "error",
      signal: controller.signal
    });
    if (!response?.ok) {
      try {
        await response?.body?.cancel?.();
      } catch {
        // Do not replace the bounded provider error with a stream cleanup error.
      }
      if (response?.status === 401) throw new Error("github_identity_rejected");
      if (response?.status === 403 && !isRateLimitedResponse(response))
        throw new Error("github_identity_rejected");
      throw new Error("github_identity_unavailable");
    }
    let payload;
    try {
      payload = await readBoundedJson(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new Error("github_identity_invalid");
    }
    const login =
      typeof payload?.login === "string" ? payload.login.trim() : "";
    if (
      !login ||
      login.length > LOGIN_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(login)
    )
      throw new Error("github_identity_invalid");
    return login;
  } catch (error) {
    if (isAbortError(error)) throw new Error("github_identity_timeout");
    if (
      error?.message === "github_identity_rejected" ||
      error?.message === "github_identity_invalid"
    )
      throw error;
    throw new Error("github_identity_unavailable");
  } finally {
    clearTimeout(timer);
  }
};

const githubError = (code, status) => {
  const error = new Error(code);
  if (status !== undefined) error.status = status;
  return error;
};

const readGithubResponse = async (fetchImpl, token, path) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "Koed Studio"
        },
        redirect: "error",
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) throw githubError("github_read_timeout");
      throw githubError("github_read_unavailable");
    }
    if (!response?.ok) {
      try {
        await response?.body?.cancel?.();
      } catch {
        // Keep the provider status as the useful failure signal.
      }
      if (response?.status === 401)
        throw githubError("github_read_rejected", response.status);
      if (isRateLimitedResponse(response))
        throw githubError("github_rate_limited", response.status);
      if (response?.status === 403 || response?.status === 404)
        throw githubError("github_read_forbidden", response.status);
      if (response?.status >= 500)
        throw githubError("github_read_unavailable", response.status);
      throw githubError("github_read_failed", response?.status);
    }
    try {
      return await readBoundedJson(response, GITHUB_READ_RESPONSE_MAX_BYTES);
    } catch (error) {
      if (isAbortError(error)) throw githubError("github_read_timeout");
      if (error?.message === "github_response_too_large") throw error;
      throw githubError("github_read_invalid");
    }
  } finally {
    clearTimeout(timer);
  }
};

const validPage = (page) =>
  Number.isInteger(page) && page >= 1 && page <= GITHUB_MAX_PAGE;

const parsePage = (page) => {
  const value = Number(page);
  if (!Number.isInteger(value) || !validPage(value))
    throw githubError("github_invalid_page");
  return value;
};

const validRepository = (repository) => {
  if (
    typeof repository !== "string" ||
    repository.length > 2 * REPOSITORY_PART_MAX_LENGTH
  )
    return null;
  const match = /^([^/]+)\/([^/]+)$/.exec(repository);
  if (!match) return null;
  const [, owner, name] = match;
  if (
    owner.length > REPOSITORY_PART_MAX_LENGTH ||
    name.length > REPOSITORY_PART_MAX_LENGTH ||
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

const encodePathPart = (value) => encodeURIComponent(value);

const safeString = (value, fallback = "") =>
  typeof value === "string" && value.length <= MAX_FIELD_LENGTH
    ? value
    : fallback;

const mapReviewer = (reviewer) => {
  const value = reviewer?.login ?? reviewer?.slug ?? reviewer?.name;
  return safeString(value).trim();
};

const mapPullRequest = (
  payload,
  { detail = false, requestedNumber = null } = {}
) => {
  const number = payload?.number;
  const title = payload?.title;
  const state = payload?.state;
  const author = payload?.user?.login;
  const headSha = payload?.head?.sha;
  const baseSha = payload?.base?.sha;
  const headBranch = payload?.head?.ref;
  const baseBranch = payload?.base?.ref;
  const updatedAt = payload?.updated_at;
  const url = payload?.html_url;
  if (
    !Number.isInteger(number) ||
    number < 1 ||
    (requestedNumber !== null && number !== requestedNumber) ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > MAX_FIELD_LENGTH ||
    (state !== "open" && state !== "closed") ||
    typeof author !== "string" ||
    !author.trim() ||
    author.length > MAX_FIELD_LENGTH ||
    typeof headSha !== "string" ||
    !headSha.trim() ||
    headSha.length > MAX_FIELD_LENGTH ||
    typeof baseSha !== "string" ||
    !baseSha.trim() ||
    baseSha.length > MAX_FIELD_LENGTH ||
    typeof headBranch !== "string" ||
    !headBranch.trim() ||
    headBranch.length > MAX_FIELD_LENGTH ||
    typeof baseBranch !== "string" ||
    !baseBranch.trim() ||
    baseBranch.length > MAX_FIELD_LENGTH ||
    typeof updatedAt !== "string" ||
    !updatedAt.trim() ||
    updatedAt.length > MAX_FIELD_LENGTH ||
    typeof url !== "string" ||
    !url.trim() ||
    url.length > MAX_FIELD_LENGTH
  )
    throw githubError("github_read_invalid");
  const reviewers = Array.isArray(payload?.requested_reviewers)
    ? payload.requested_reviewers.map(mapReviewer).filter(Boolean)
    : [];
  const mapped = {
    number,
    title,
    state,
    draft: payload?.draft === true,
    merged: payload?.merged === true || Boolean(payload?.merged_at),
    author: author.trim(),
    requestedReviewers: [...new Set(reviewers)],
    headSha: headSha.trim(),
    baseSha: baseSha.trim(),
    headBranch: headBranch.trim(),
    baseBranch: baseBranch.trim(),
    updatedAt: updatedAt.trim(),
    url: url.trim()
  };
  if (detail) {
    if (payload?.body !== null && typeof payload?.body !== "string")
      throw githubError("github_read_invalid");
    if (
      !Number.isInteger(payload?.additions) ||
      payload.additions < 0 ||
      !Number.isInteger(payload?.deletions) ||
      payload.deletions < 0 ||
      !Number.isInteger(payload?.changed_files) ||
      payload.changed_files < 0
    )
      throw githubError("github_read_invalid");
    mapped.body =
      typeof payload?.body === "string"
        ? payload.body.slice(0, MAX_BODY_LENGTH)
        : "";
    mapped.bodyTruncated =
      typeof payload?.body === "string" &&
      payload.body.length > MAX_BODY_LENGTH;
    mapped.additions = payload.additions;
    mapped.deletions = payload.deletions;
    mapped.changedFiles = payload.changed_files;
  }
  return mapped;
};

const mapRepository = (payload) => {
  if (
    !(
      typeof payload?.id === "number" ||
      (typeof payload?.id === "string" && payload.id.length > 0)
    ) ||
    !validRepository(payload?.full_name) ||
    typeof payload?.private !== "boolean"
  )
    throw githubError("github_read_invalid");
  return {
    id: payload.id,
    fullName: payload.full_name,
    private: payload.private
  };
};

const publicError = (error) => {
  switch (error?.message) {
    case "github_cli_missing":
      return "GitHub CLI is unavailable.";
    case "github_cli_auth_failed":
      return "GitHub CLI authentication failed.";
    case "github_identity_timeout":
      return "GitHub identity check timed out.";
    case "github_identity_rejected":
      return "GitHub authentication was rejected.";
    case "github_identity_invalid":
      return "GitHub returned an invalid identity response.";
    case "github_not_connected":
      return "GitHub is not connected.";
    case "github_account_changed":
      return "The connected GitHub account changed.";
    case "github_read_timeout":
      return "GitHub request timed out.";
    case "github_read_rejected":
      return "GitHub authentication was rejected.";
    case "github_rate_limited":
      return "GitHub rate limit reached.";
    case "github_read_forbidden":
      return "GitHub access to this resource was denied.";
    case "github_read_unavailable":
      return "GitHub is temporarily unavailable.";
    case "github_read_invalid":
      return "GitHub returned an invalid response.";
    case "github_response_too_large":
      return "GitHub returned too much data.";
    case "github_read_failed":
      return "GitHub request failed.";
    default:
      return "GitHub identity check failed.";
  }
};

const readGhToken = async (execFile) => {
  let result;
  try {
    result = await execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      {
        encoding: "utf8",
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        cwd: homedir(),
        windowsHide: true
      }
    );
  } catch (error) {
    const normalized = new Error(
      error?.code === "ENOENT" ? "github_cli_missing" : "github_cli_auth_failed"
    );
    throw normalized;
  }
  const token = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  if (!token || token.length > GH_MAX_BUFFER || /[\u0000\r\n]/.test(token))
    throw new Error("github_cli_auth_failed");
  return token;
};

// The token is used only for the identity request. The connector exposes
// identity and capability state, never credential material.
export const createGithubConnector = ({
  execFile = defaultExecFile,
  fetchImpl = globalThis.fetch
} = {}) => {
  let status = disconnectedStatus();
  let generation = 0;

  const getStatus = () => ({
    ...status,
    capabilities: { ...status.capabilities }
  });

  const disconnect = () => {
    generation += 1;
    status = disconnectedStatus();
    return getStatus();
  };

  const connect = async () => {
    const operation = ++generation;
    let token;
    let login;
    try {
      token = await readGhToken(execFile);
      login = await readGithubIdentity(fetchImpl, token);
    } catch (error) {
      if (operation !== generation) return getStatus();
      status = errorStatus(publicError(error));
      return getStatus();
    }
    if (operation !== generation) return getStatus();
    status = connectedStatus(login);
    return getStatus();
  };

  const readWithIdentity = async (operation) => {
    const operationGeneration = generation;
    const connectedLogin = status.state === "connected" ? status.login : null;
    if (!connectedLogin) throw githubError("github_not_connected");
    let token;
    let refreshedLogin;
    try {
      token = await readGhToken(execFile);
      refreshedLogin = await readGithubIdentity(fetchImpl, token);
    } catch (error) {
      if (
        operationGeneration === generation &&
        (error?.message === "github_cli_missing" ||
          error?.message === "github_cli_auth_failed" ||
          error?.message === "github_identity_rejected")
      ) {
        generation += 1;
        status = errorStatus(publicError(error));
      }
      throw error;
    }
    if (operationGeneration !== generation)
      throw githubError("github_not_connected");
    if (
      refreshedLogin.toLocaleLowerCase() !== connectedLogin.toLocaleLowerCase()
    ) {
      generation += 1;
      status = errorStatus("GitHub account changed; reconnect required.");
      throw githubError("github_account_changed");
    }
    const result = await operation(token, operationGeneration);
    if (operationGeneration !== generation)
      throw githubError("github_not_connected");
    return result;
  };

  const readRepositories = async ({ page = 1 } = {}) => {
    const pageNumber = parsePage(page);
    return readWithIdentity(async (token) => {
      const params = new URLSearchParams({
        affiliation: "owner,collaborator,organization_member",
        direction: "desc",
        page: String(pageNumber),
        per_page: String(GITHUB_PAGE_SIZE),
        sort: "updated"
      });
      const payload = await readGithubResponse(
        fetchImpl,
        token,
        `/user/repos?${params.toString()}`
      );
      if (!Array.isArray(payload)) throw githubError("github_read_invalid");
      const repositories = payload
        .slice(0, GITHUB_PAGE_SIZE)
        .map(mapRepository);
      return {
        repositories,
        hasMore: payload.length >= GITHUB_PAGE_SIZE,
        page: pageNumber
      };
    });
  };

  const readPullRequests = async ({ repo, repository, page = 1 } = {}) => {
    const pageNumber = parsePage(page);
    const parsedRepository = validRepository(repo ?? repository);
    if (!parsedRepository) throw githubError("github_invalid_repository");
    return readWithIdentity(async (token) => {
      const params = new URLSearchParams({
        direction: "desc",
        page: String(pageNumber),
        per_page: String(GITHUB_PAGE_SIZE),
        sort: "updated",
        state: "all"
      });
      const payload = await readGithubResponse(
        fetchImpl,
        token,
        `/repos/${encodePathPart(parsedRepository.owner)}/${encodePathPart(
          parsedRepository.name
        )}/pulls?${params.toString()}`
      );
      if (!Array.isArray(payload)) throw githubError("github_read_invalid");
      return {
        pullRequests: payload
          .slice(0, GITHUB_PAGE_SIZE)
          .map((pullRequest) => mapPullRequest(pullRequest)),
        hasMore: payload.length >= GITHUB_PAGE_SIZE,
        page: pageNumber
      };
    });
  };

  const readPullRequest = async ({ repo, repository, number } = {}) => {
    const parsedRepository = validRepository(repo ?? repository);
    const pullNumber = Number(number);
    if (
      !parsedRepository ||
      !Number.isInteger(pullNumber) ||
      pullNumber < 1 ||
      pullNumber > 2 ** 31 - 1
    )
      throw githubError("github_invalid_pull_request");
    return readWithIdentity(async (token) => {
      const payload = await readGithubResponse(
        fetchImpl,
        token,
        `/repos/${encodePathPart(parsedRepository.owner)}/${encodePathPart(
          parsedRepository.name
        )}/pulls/${pullNumber}`
      );
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw githubError("github_read_invalid");
      return {
        pullRequest: mapPullRequest(payload, {
          detail: true,
          requestedNumber: pullNumber
        })
      };
    });
  };

  const readPullRequestContext = async ({ repo, number } = {}) => {
    const repository = validRepository(repo);
    if (!repository || !Number.isSafeInteger(number) || number < 1)
      throw githubError("github_invalid_pull_request");
    return readWithIdentity(async (token) => {
      const path = `/repos/${encodePathPart(repository.owner)}/${encodePathPart(repository.name)}/pulls/${number}`;
      const readHead = async () =>
        mapPullRequest(await readGithubResponse(fetchImpl, token, path), {
          detail: true,
          requestedNumber: number
        });
      const pullRequest = await readHead();
      const payload = await readGithubResponse(
        fetchImpl,
        token,
        `${path}/files?per_page=30&page=1`
      );
      if (!Array.isArray(payload)) throw githubError("github_read_invalid");
      let budget = 96 * 1024;
      const files = payload.slice(0, 30).map((file) => {
        if (typeof file?.filename !== "string" || file.filename.length > 2048)
          throw githubError("github_read_invalid");
        const source = typeof file.patch === "string" ? file.patch : "";
        const patch = source.slice(0, Math.min(16 * 1024, budget));
        budget -= patch.length;
        return {
          path: file.filename,
          status: safeString(file.status),
          additions: Number.isSafeInteger(file.additions)
            ? file.additions
            : null,
          deletions: Number.isSafeInteger(file.deletions)
            ? file.deletions
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
        filesTruncated: pullRequest.changedFiles > files.length
      };
    });
  };

  return Object.freeze({
    connect,
    disconnect,
    getStatus,
    readRepositories,
    readPullRequests,
    readPullRequest,
    readPullRequestContext
  });
};

export const githubConstants = Object.freeze({
  githubResponseMaxBytes: GITHUB_RESPONSE_MAX_BYTES,
  githubReadResponseMaxBytes: GITHUB_READ_RESPONSE_MAX_BYTES,
  ghMaxBuffer: GH_MAX_BUFFER,
  ghTimeoutMs: GH_TIMEOUT_MS,
  githubPageSize: GITHUB_PAGE_SIZE
});
