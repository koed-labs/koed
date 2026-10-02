import { createGithubDelegatedCli } from "@koed/shared/github-delegated";

const capabilities = Object.freeze({
  readPullRequests: false,
  publishReviews: false
});
const connectedCapabilities = Object.freeze({
  readPullRequests: true,
  publishReviews: true
});

const statusFor = (state, login, message, generation, accountId = null) => ({
  state,
  login,
  accountId,
  message,
  connectionGeneration: generation,
  capabilities: {
    ...(state === "connected" ? connectedCapabilities : capabilities)
  }
});

const publicError = (error) => {
  switch (error?.code ?? error?.message) {
    case "github_cli_missing":
      return "GitHub CLI is unavailable.";
    case "github_not_connected":
    case "github_account_unavailable":
      return "GitHub is not connected.";
    case "github_account_changed":
      return "The connected GitHub account changed; reconnect required.";
    case "github_read_timeout":
      return "GitHub request timed out.";
    case "github_read_rejected":
      return "GitHub authentication was rejected.";
    case "github_response_too_large":
      return "GitHub returned too much data.";
    case "github_rate_limited":
      return "GitHub rate limit reached.";
    case "github_head_changed":
    case "github_context_changed":
      return "The pull request changed; refresh it before continuing.";
    case "github_publication_uncertain":
      return "GitHub may have received the review. Check the review history before retrying.";
    case "github_invalid_repository":
    case "github_invalid_pull_request":
    case "github_invalid_review":
    case "github_invalid_page":
    case "github_invalid_account":
      return "The GitHub request was invalid.";
    case "github_read_forbidden":
      return "GitHub access to this resource was denied.";
    default:
      return "GitHub request failed.";
  }
};

const connectorError = (code) => Object.assign(new Error(code), { code });

export const createGithubConnector = ({
  delegatedCli,
  execFile,
  environment
} = {}) => {
  const delegated =
    delegatedCli ??
    createGithubDelegatedCli({
      ...(execFile ? { execFile } : {}),
      ...(environment ? { environment } : {})
    });
  let generation = 0;
  let status = statusFor("disconnected", null, null, generation);

  const getStatus = () => ({
    ...status,
    capabilities: { ...status.capabilities }
  });
  const getGeneration = () => generation;

  const disconnect = () => {
    generation += 1;
    status = statusFor("disconnected", null, null, generation);
    return getStatus();
  };

  const markError = (error, operation) => {
    if (operation !== generation) return getStatus();
    generation += 1;
    status = statusFor("error", null, publicError(error), generation);
    return getStatus();
  };

  const connect = async () => {
    const operation = ++generation;
    try {
      const account = await delegated.getActiveAccount();
      if (operation !== generation) return getStatus();
      status = statusFor(
        "connected",
        account.login,
        null,
        generation,
        account.id
      );
    } catch (error) {
      return markError(error, operation);
    }
    return getStatus();
  };

  const discoverAccounts = async () => delegated.discoverAccounts();

  const selectAccount = async ({ login } = {}) => {
    const operation = ++generation;
    status = statusFor("disconnected", null, null, generation);
    try {
      const account = await delegated.selectAccount({ login });
      if (operation !== generation) return getStatus();
      status = statusFor(
        "connected",
        account.login,
        null,
        generation,
        account.id
      );
    } catch (error) {
      return markError(error, operation);
    }
    return getStatus();
  };

  const beginBrowserSignIn = async () => {
    const operation = ++generation;
    status = statusFor("disconnected", null, null, generation);
    try {
      const account = await delegated.beginBrowserSignIn();
      if (operation !== generation) return getStatus();
      status = statusFor(
        "connected",
        account.login,
        null,
        generation,
        account.id
      );
    } catch (error) {
      return markError(error, operation);
    }
    return getStatus();
  };

  const runConnected = async (method, input = {}) => {
    const operation = generation;
    const login = status.state === "connected" ? status.login : null;
    if (!login) throw connectorError("github_not_connected");
    if (
      input?.expectedConnectionGeneration !== undefined &&
      input.expectedConnectionGeneration !== operation
    )
      throw connectorError("github_not_connected");
    if (
      input?.expectedAccountLogin !== undefined &&
      (typeof input.expectedAccountLogin !== "string" ||
        input.expectedAccountLogin.toLocaleLowerCase() !==
          login.toLocaleLowerCase())
    )
      throw connectorError("github_account_changed");
    const { expectedConnectionGeneration, ...forwarded } = input ?? {};
    let result;
    try {
      result = await delegated[method]({
        ...forwarded,
        expectedAccountLogin: login
      });
    } catch (error) {
      if (
        operation === generation &&
        [
          "github_account_changed",
          "github_not_connected",
          "github_cli_missing"
        ].includes(error?.code ?? error?.message)
      )
        markError(error, operation);
      throw error;
    }
    if (operation !== generation) throw connectorError("github_not_connected");
    return result;
  };

  const publishReview = async (input = {}) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw connectorError("github_invalid_review");
    return runConnected("publishReview", input);
  };

  return Object.freeze({
    connect,
    disconnect,
    getStatus,
    getGeneration,
    discoverAccounts,
    selectAccount,
    beginBrowserSignIn,
    readRepositories: (input = {}) => runConnected("readRepositories", input),
    readRepository: (input = {}) => runConnected("readRepository", input),
    readPullRequests: (input = {}) => runConnected("readPullRequests", input),
    readPullRequest: (input = {}) => runConnected("readPullRequest", input),
    readPullRequestContext: (input = {}) =>
      runConnected("readPullRequestContext", input),
    readInbox: (input = {}) => runConnected("readInbox", input),
    publishReview,
    readPublishedReview: (input = {}) =>
      runConnected("readPublishedReview", input),
    readPublishedReviewComments: (input = {}) =>
      runConnected("readPublishedReviewComments", input)
  });
};
