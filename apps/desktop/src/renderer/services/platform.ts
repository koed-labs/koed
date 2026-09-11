import { safeExternalUrl } from "../../window/external-url.js";
import { personalDesktopProjectMetadataSchema } from "@koed/shared/personal-desktop";
import type { DesktopProjectMetadata } from "../../project-memory-ui.js";

// Discovery includes local indexing details that are not part of the desktop
// metadata contract. Normalize those responses while validating every UI field.
const metadataShape = personalDesktopProjectMetadataSchema.shape;
const gitShape = metadataShape.git.unwrap().shape;
const discoveredProjectSchema = personalDesktopProjectMetadataSchema
  .extend({
    path: metadataShape.path.strip(),
    git: metadataShape.git
      .unwrap()
      .extend({
        remotes: gitShape.remotes.element.strip().array().max(100)
      })
      .strip()
      .optional()
  })
  .strip();

export type RendererPlatform = {
  copyText: (value: string) => Promise<void>;
  openExternal: (value: string) => Promise<void>;
  ensureIndependentProject: () => Promise<DesktopProjectMetadata>;
  revealLocalProject: (localProjectId: string) => Promise<void>;
  selectProjectDirectory: () => Promise<DesktopProjectMetadata | null>;
};

export const createRendererPlatform = (): RendererPlatform => ({
  copyText: async (value) => {
    const clipboard = window.koedDesktop?.clipboard;
    if (!clipboard) throw new Error("Clipboard unavailable.");
    await clipboard.writeText(value);
  },
  ensureIndependentProject: async () => {
    const response = await window.koedDesktop?.invoke<{ project?: unknown }>(
      "ensure_independent_project"
    );
    return discoveredProjectSchema.parse(response?.project);
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
  },
  selectProjectDirectory: async () => {
    const response = await window.koedDesktop?.invoke<{
      canceled?: boolean;
      result?: { project?: unknown };
    }>("select_project_directory");
    if (response?.canceled) return null;
    const project = discoveredProjectSchema.parse(response?.result?.project);
    return project;
  }
});
