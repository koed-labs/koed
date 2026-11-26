export const kinResolutions = ["classic", "balanced", "max"] as const;
export type KinResolution = (typeof kinResolutions)[number];

export type PresentationPreferences = {
  graphicsAcceleration: boolean;
  showMenuBar: boolean;
  floatingKin: boolean;
  kinResolution: KinResolution;
};

export const defaultPresentationPreferences: PresentationPreferences = {
  graphicsAcceleration: true,
  showMenuBar: true,
  floatingKin: false,
  kinResolution: "max"
};

export type PresentationPreferencesApi = {
  get: () => Promise<PresentationPreferences>;
  set: (
    changes: Partial<PresentationPreferences>
  ) => Promise<PresentationPreferences>;
};
