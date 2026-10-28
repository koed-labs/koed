import type {
  VerifiedComponent,
  VerifiedDesktopBase,
  VerifiedGeneration,
  VerifiedManifestPinnedComponent
} from "./component-contract.js";

// Compile-only contract: Desktop bundles never satisfy manifest-pinned inputs.
function checkArtifactContract(
  artifact: VerifiedComponent,
  desktop: VerifiedDesktopBase,
  pinned: VerifiedManifestPinnedComponent,
  generation: VerifiedGeneration
): void {
  if (artifact.kind === "manifest-pinned-component") {
    const component: VerifiedManifestPinnedComponent = artifact;
    void component.manifest.archive;
    void component.manifest.runtimes;
  } else {
    const base: VerifiedDesktopBase = artifact;
    // @ts-expect-error Desktop bundles have no pinned archive.
    void base.manifest.archive;
    // @ts-expect-error Desktop bundles have no pinned runtime compatibility.
    void base.manifest.runtimes;
  }
  generation.base = desktop;
  generation.base = pinned;
  generation.privacy = pinned;
  // @ts-expect-error Privacy must be a verified manifest-pinned component.
  generation.privacy = desktop;
  // @ts-expect-error Desktop bundle cannot enter manifest-pinned staging.
  const component: VerifiedManifestPinnedComponent = desktop;
  void component;
}
void checkArtifactContract;
