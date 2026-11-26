import { useEffect, useState } from "react";
import type {
  PresentationPreferences,
  PresentationPreferencesApi
} from "../../ipc/presentation-preferences-protocol.js";
import { setKinResolution } from "../state/kin-resolution.js";

export type PresentationSettingsState = ReturnType<
  typeof usePresentationPreferences
>;
const pendingWrites = new WeakMap<PresentationPreferencesApi, Promise<void>>();

export function usePresentationPreferences(api?: PresentationPreferencesApi) {
  const [saved, setSaved] = useState<PresentationPreferences | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const read = () => api.get();
    const queued = pendingWrites.get(api);
    void (queued ? queued.then(read) : read())
      .then((value) => {
        if (active) {
          setKinResolution(value.kinResolution);
          setSaved(value);
        }
      })
      .catch(() => {
        if (active) setError("Window settings could not be read.");
      });
    return () => {
      active = false;
    };
  }, [api]);

  const update = (changes: Partial<PresentationPreferences>) => {
    if (!api || !saved) return Promise.resolve();
    setPending((count) => count + 1);
    // Keyboard input can commit another stop before the previous write returns.
    const write = (pendingWrites.get(api) ?? Promise.resolve()).then(
      async () => {
        setError(null);
        try {
          const next = await api.set(changes);
          setKinResolution(next.kinResolution);
          setSaved(next);
        } catch {
          setError("Window settings could not be changed.");
        } finally {
          setPending((count) => count - 1);
        }
      }
    );
    pendingWrites.set(api, write);
    return write;
  };

  return { available: !!api, saved, busy: pending > 0, error, update };
}
