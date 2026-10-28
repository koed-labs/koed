/**
 * Which Koed this window runs. The main process decides it from the
 * environment (see ipc/desktop-feature-flags.ts) and the preload exposes it.
 *
 * Component tests run without a preload and see the full edition, so every
 * existing behaviour stays covered; Solo only narrows what is shown.
 */
const flags = () =>
  typeof window === "undefined" ? undefined : window.koedDesktop?.featureFlags;

export const soloEdition = (): boolean => flags()?.edition === "solo";

/** Settings › Phone and the phone gateway (v1.5). */
export const phoneEnabled = (): boolean => {
  const current = flags();
  return current ? current.phoneEnabled === true : true;
};
