"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";

export type StudioSettingsComputerState = {
  selectedDeviceId: string;
  setSelectedDeviceId: Dispatch<SetStateAction<string>>;
};

export const StudioSettingsComputerContext =
  createContext<StudioSettingsComputerState | null>(null);

export function useStudioSettingsComputer() {
  const state = useContext(StudioSettingsComputerContext);
  if (!state) {
    throw new Error("Studio settings computer context is unavailable.");
  }
  return state;
}

export function useStudioDesktopAvailability(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    queueMicrotask(() => setAvailable(Boolean(window.koedDesktop)));
  }, []);
  return available;
}
