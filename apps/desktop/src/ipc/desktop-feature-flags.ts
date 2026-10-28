export type DesktopEdition = "solo" | "full";

export type DesktopFeatureFlags = Readonly<{
  hqEnabled: boolean;
  teamCollaborationEnabled: boolean;
  /**
   * Solo is the open-source v1.0: one person, the embedded backend, memory
   * shared by their local AI Clients and one Chief of Staff. It hides
   * creating Projects and chats, Team and sharing, hiring agents, scheduled
   * jobs, decks and to-dos. Nothing is removed; `KOED_EDITION=full` shows it
   * all again.
   */
  edition: DesktopEdition;
  /** The phone gateway and Settings › Phone (v1.5). */
  phoneEnabled: boolean;
}>;

export const desktopFeatureFlagsFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): DesktopFeatureFlags => {
  const edition: DesktopEdition =
    environment.KOED_EDITION === "full" ? "full" : "solo";
  return Object.freeze({
    hqEnabled:
      environment.KOED_DESKTOP_HQ_ENABLED === undefined ||
      environment.KOED_DESKTOP_HQ_ENABLED === "true",
    teamCollaborationEnabled:
      environment.KOED_TEAM_COLLABORATION_ENABLED === "true",
    edition,
    phoneEnabled: environment.KOED_PHONE_ENABLED === "true"
  });
};
