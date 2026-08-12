const usableToken = (value) => {
  const token = value?.trim();
  return token && !token.includes("replace_with_token") ? token : null;
};

const usableUrl = (value) => {
  const url = value?.trim();
  return url ? url.replace(/\/+$/, "") : null;
};

export const resolveCaptureVerificationConfig = ({
  environment = {},
  rootEnv = {},
  hookConfig = {}
}) => ({
  apiUrl:
    usableUrl(environment.MEMORY_API_URL) ??
    usableUrl(hookConfig.apiUrl) ??
    usableUrl(rootEnv.MEMORY_API_URL) ??
    (environment.API_HOST_PORT
      ? `http://localhost:${environment.API_HOST_PORT}`
      : null) ??
    (rootEnv.API_HOST_PORT
      ? `http://localhost:${rootEnv.API_HOST_PORT}`
      : null) ??
    "http://localhost:3300",
  apiToken:
    usableToken(environment.MEMORY_API_TOKEN) ??
    usableToken(hookConfig.apiToken) ??
    usableToken(rootEnv.MEMORY_API_TOKEN)
});
