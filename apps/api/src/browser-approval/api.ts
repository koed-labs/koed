import type { HighRiskBrowserActivation } from "../high-risk/schemas.js";
import type { PublicDeviceEnrollmentChallenge } from "../local-edge/schemas.js";

export type BrowserAuthProvider = "local" | "workos";

export class BrowserApprovalRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "BrowserApprovalRequestError";
  }
}

export const browserApprovalBasePath = (): string => {
  const match = window.location.pathname.match(
    /^(.*)\/(?:high-risk\/browser-activations|device-enrollment)\/[^/]+\/?$/
  );
  return match?.[1] ?? "";
};

export const approvalApiPath = (path: `/${string}`): string =>
  `${browserApprovalBasePath()}${path}`;

const requestJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(
    approvalApiPath(`/${path.replace(/^\/+/, "")}`),
    {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init?.headers
      }
    }
  );
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof body.error === "string"
        ? body.error
        : `Request failed with ${response.status}`;
    throw new BrowserApprovalRequestError(message, response.status);
  }
  return body as T;
};

export const authenticationRequired = (error: unknown): boolean =>
  error instanceof BrowserApprovalRequestError &&
  (error.status === 401 ||
    (error.status === 403 &&
      error.message === "Fresh browser authentication is required"));

export const notFound = (error: unknown): boolean =>
  error instanceof BrowserApprovalRequestError && error.status === 404;

export const loadBrowserAuthProviders = async (): Promise<
  BrowserAuthProvider[]
> => {
  const response = await requestJson<{ auth?: { providers?: unknown } }>(
    "/v1/capabilities"
  );
  return Array.isArray(response.auth?.providers)
    ? response.auth.providers.filter(
        (provider): provider is BrowserAuthProvider =>
          provider === "local" || provider === "workos"
      )
    : [];
};

export const loginWithLocalSession = async (
  email: string,
  password: string
): Promise<void> => {
  await requestJson("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
};

export const requireBrowserSession = async (): Promise<void> => {
  await requestJson("/me");
};

export const loadHighRiskBrowserActivation = (
  selector: string
): Promise<HighRiskBrowserActivation> =>
  requestJson(
    `/v1/high-risk/browser-activations/${encodeURIComponent(selector)}`
  );

export const decideHighRiskBrowserActivation = (
  selector: string,
  decision: "approve" | "deny"
): Promise<HighRiskBrowserActivation> =>
  requestJson(
    `/v1/high-risk/browser-activations/${encodeURIComponent(selector)}/decision`,
    { method: "POST", body: JSON.stringify({ decision }) }
  );

export const loadDeviceEnrollmentChallenge = async (
  challengeId: string
): Promise<PublicDeviceEnrollmentChallenge> => {
  const response = await requestJson<{
    challenge: PublicDeviceEnrollmentChallenge;
  }>(
    `/v1/local-edge/device-enrollments/challenges/${encodeURIComponent(challengeId)}`
  );
  return response.challenge;
};

export const decideDeviceEnrollmentChallenge = async (
  challengeId: string,
  decision: "approve" | "deny"
): Promise<PublicDeviceEnrollmentChallenge> => {
  const response = await requestJson<{
    challenge: PublicDeviceEnrollmentChallenge;
  }>(
    `/v1/local-edge/device-enrollments/challenges/${encodeURIComponent(challengeId)}/approval`,
    { method: "POST", body: JSON.stringify({ decision }) }
  );
  return response.challenge;
};

export const approvalReturnPath = (): string =>
  `${window.location.pathname}${window.location.search}`;

export const workosLoginUrl = (): string =>
  `${approvalApiPath("/auth/workos/login")}?return_to=${encodeURIComponent(approvalReturnPath())}`;
