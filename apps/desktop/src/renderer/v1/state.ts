import type {
  V1StateDesktopApi,
  V1Profile
} from "../../ipc/v1-state-protocol.js";

export const v1State = (): V1StateDesktopApi => {
  const api = window.koedDesktop?.v1State;
  if (!api) throw new Error("V1 state is unavailable.");
  return api;
};

export const readV1Identity = async () => v1State().readIdentity();
export const readV1Profile = async (): Promise<V1Profile> =>
  v1State().readProfile();
export const saveV1Profile = async (profile: V1Profile): Promise<V1Profile> =>
  v1State().writeProfile(profile);
