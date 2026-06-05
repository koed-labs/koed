/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_KOED_API_BASE_URL: string;
  readonly VITE_KOED_API_TOKEN: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
