import { safeExternalUrl } from "../../window/external-url.js";

export type RendererPlatform = {
  copyText: (value: string) => Promise<void>;
  openExternal: (value: string) => Promise<void>;
  revealLocalProject: (localProjectId: string) => Promise<void>;
};

export const createRendererPlatform = (): RendererPlatform => ({
  copyText: async (value) => {
    const clipboard = window.koedDesktop?.clipboard;
    if (!clipboard) throw new Error("Clipboard unavailable.");
    await clipboard.writeText(value);
  },
  openExternal: async (value) => {
    const url = safeExternalUrl(value);
    if (!url) throw new Error("Unsupported external URL.");
    const result = await window.koedDesktop?.invoke<{
      ok?: boolean;
      error?: string;
    }>("open_external", { url });
    if (!result?.ok) {
      throw new Error(result?.error || "External link could not be opened.");
    }
  },
  revealLocalProject: async (localProjectId) => {
    if (!/^lp_[0-9a-f]{32}$/.test(localProjectId)) {
      throw new Error("Local Project identity is invalid.");
    }
    const result = await window.koedDesktop?.invoke<{
      ok?: boolean;
      error?: string;
    }>("reveal_local_project", { localProjectId });
    if (!result?.ok) {
      throw new Error(result?.error || "Local Project could not be revealed.");
    }
  }
});
