import type {
  VerifiedComponent,
  VerifiedDesktopBase,
  VerifiedGeneration,
  VerifiedSignedComponent
} from "./component-contract.js";

// Compile-only contract: Desktop bundles never satisfy signed installer inputs.
function checkArtifactContract(
  artifact: VerifiedComponent,
  desktop: VerifiedDesktopBase,
  signed: VerifiedSignedComponent,
  generation: VerifiedGeneration
): void {
  if (artifact.kind === "signed-component") {
    const component: VerifiedSignedComponent = artifact;
    void component.manifest.archive;
    void component.manifest.runtimes;
  } else {
    const base: VerifiedDesktopBase = artifact;
    // @ts-expect-error Desktop bundles have no signed archive.
    void base.manifest.archive;
    // @ts-expect-error Desktop bundles have no signed runtime compatibility.
    void base.manifest.runtimes;
  }
  generation.base = desktop;
  generation.base = signed;
  generation.privacy = signed;
  // @ts-expect-error Privacy must be a verified signed component.
  generation.privacy = desktop;
  // @ts-expect-error Desktop bundle cannot enter signed-component staging.
  const component: VerifiedSignedComponent = desktop;
  void component;
}
void checkArtifactContract;
