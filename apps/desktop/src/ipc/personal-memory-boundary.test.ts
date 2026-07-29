import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopSourceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const source = (relativePath: string): string =>
  readFileSync(resolve(desktopSourceDirectory, relativePath), "utf8");

describe("Personal Memory renderer boundary", () => {
  it("keeps reusable credentials and HTTP transport out of renderer surfaces", () => {
    const renderer = source("renderer/App.tsx");
    const personalMemory = source(
      "renderer/views/personal/PersonalMemoryViews.tsx"
    );
    const conversation = source("NativeConversationSurface.tsx");

    expect([renderer, personalMemory].join("\n")).not.toMatch(
      /explorerApiToken|explorer_credential|authorization\s*:|fetch\s*\(/
    );
    expect(conversation).not.toMatch(
      /apiBaseUrl|apiToken|authorization|fetch\s*\(/
    );
  });

  it("does not expose the former credential command through preload", () => {
    const preload = source("preload.cts");
    expect(preload).not.toContain("explorer_credential");
    expect(preload).not.toMatch(/apiToken|authorization\s*:|Bearer\s/);
  });

  it("keeps Team transport, credentials, and persistent connection state out of renderer code", () => {
    const preload = source("preload.cts");
    const renderer = source("renderer/App.tsx");
    const collaborationClient = source("collaboration/renderer-client.ts");
    const collaborationController = source(
      "renderer/collaboration/useCollaborationController.ts"
    );
    const collaborationRoutes = source(
      "renderer/collaboration/CollaborationRoutesImpl.tsx"
    );
    const collaborationRendererSources = [
      collaborationClient,
      collaborationController,
      collaborationRoutes
    ].join("\n");

    expect(collaborationRendererSources).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie/
    );
    expect([renderer, collaborationRendererSources].join("\n")).not.toMatch(
      /fetch\s*\(|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|XMLHttpRequest/
    );
    expect(collaborationRendererSources).not.toMatch(
      /Koed-Desktop\s|Bearer\s|authorization\s*:|apiToken|sessionCookie/
    );
    expect(preload).not.toMatch(
      /Koed-Desktop\s|Bearer\s|authorization\s*:|apiToken|sessionCookie/
    );
    expect(preload).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|fetch\s*\(|new\s+WebSocket/
    );
  });
});
