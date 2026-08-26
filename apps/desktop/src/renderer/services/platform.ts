import { safeExternalUrl } from "../../window/external-url.js";

export type RendererPlatform = {
  copyText: (value: string) => Promise<void>;
  openExternal: (value: string) => Promise<void>;
  openLocalPath: (path: string) => Promise<void>;
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
  openLocalPath: async (path) => {
    if (!path.trim()) throw new Error("A local path is required.");
    const result = await window.koedDesktop?.invoke<{
      ok?: boolean;
      error?: string;
    }>("open_path", { path });
    if (!result?.ok) {
      throw new Error(result?.error || "Local path could not be opened.");
    }
  }
});
