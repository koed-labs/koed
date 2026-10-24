import type { ManifestPinCatalog } from "./component-manifest-catalog.js";

// Replaced only in control-plane build output from the explicit release catalog.
// Source/component-runtime builds deliberately have no component admission authority.
export const productionComponentManifestCatalog: ManifestPinCatalog | null =
  null;
