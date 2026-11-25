import {
  defaultPresentationPreferences,
  type KinResolution
} from "../../ipc/presentation-preferences-protocol.js";

let resolution = defaultPresentationPreferences.kinResolution;
const listeners = new Set<() => void>();

export const currentKinResolution = () => resolution;

export function setKinResolution(next: KinResolution) {
  if (next === resolution) return;
  resolution = next;
  for (const listener of listeners) listener();
}

export function subscribeKinResolution(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
