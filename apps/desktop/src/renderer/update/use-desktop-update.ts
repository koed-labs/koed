import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopUpdateApi } from "../../types.js";
import type { DesktopUpdateCommand, DesktopUpdateState } from "@koed/shared";

export type DesktopUpdateController = {
  api: DesktopUpdateApi | null;
  state: DesktopUpdateState;
  version: string;
  open: boolean;
  notice: string | null;
  manualError: string | null;
  busy: DesktopUpdateCommand | null;
  openSurface: () => void;
  closeSurface: () => void;
  check: () => void;
  download: () => void;
  install: () => void;
};

const unavailableState: DesktopUpdateState = {
  reason: "unsupported",
  status: "disabled"
};

const commandForStatus = (
  status: DesktopUpdateState["status"]
): DesktopUpdateCommand | null => {
  switch (status) {
    case "checking":
      return "check";
    case "downloading":
      return "download";
    case "installing":
      return "install";
    default:
      return null;
  }
};

export function useDesktopUpdate(
  api: DesktopUpdateApi | undefined,
  version: string
): DesktopUpdateController {
  const resolvedApi = api ?? null;
  const [state, setState] = useState<DesktopUpdateState>(
    resolvedApi ? { status: "idle" } : unavailableState
  );
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [busy, setBusy] = useState<DesktopUpdateCommand | null>(null);
  const busyRef = useRef<DesktopUpdateCommand | null>(null);
  const stateRef = useRef(state);
  const revision = useRef(0);
  const request = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    revision.current += 1;
    request.current += 1;
    setState(resolvedApi ? { status: "idle" } : unavailableState);
    stateRef.current = resolvedApi ? { status: "idle" } : unavailableState;
    setNotice(null);
    setManualError(null);
    setBusy(null);
    busyRef.current = null;
    if (!resolvedApi) {
      return () => {
        mounted.current = false;
      };
    }

    const applyState = (next: DesktopUpdateState) => {
      if (!mounted.current) return;
      revision.current += 1;
      stateRef.current = next;
      setState(next);
      if (next.status !== "error") setManualError(null);
      if (!commandForStatus(next.status)) {
        setBusy(null);
        busyRef.current = null;
      }
    };
    const unsubscribe = resolvedApi.subscribe(applyState);
    const initialRevision = revision.current;
    void resolvedApi
      .getState()
      .then((next) => {
        if (!mounted.current || revision.current !== initialRevision) return;
        applyState(next);
      })
      .catch(() => undefined);

    return () => {
      mounted.current = false;
      request.current += 1;
      unsubscribe();
    };
  }, [resolvedApi]);

  const run = useCallback(
    (command: DesktopUpdateCommand) => {
      if (!resolvedApi || busy) return;
      if (busyRef.current) return;
      const runId = ++request.current;
      const startRevision = revision.current;
      const isManualCheck = command === "check";
      setBusy(command);
      busyRef.current = command;
      setNotice(null);
      if (isManualCheck) setManualError(null);
      void resolvedApi[command]()
        .then((next) => {
          if (
            mounted.current &&
            request.current === runId &&
            isManualCheck &&
            next.status === "idle" &&
            stateRef.current.status === "idle"
          ) {
            setNotice("Koed is up to date.");
          }
          if (
            !mounted.current ||
            request.current !== runId ||
            revision.current !== startRevision
          ) {
            return;
          }
          revision.current += 1;
          stateRef.current = next;
          setState(next);
          setBusy(null);
          busyRef.current = null;
        })
        .catch(() => {
          if (!mounted.current || request.current !== runId) return;
          setBusy(null);
          busyRef.current = null;
          setManualError(
            command === "check"
              ? "Koed could not check for updates. Try again."
              : command === "download"
                ? "Koed could not download this update. Try again."
                : "Koed could not prepare the restart. Try again."
          );
        });
    },
    [busy, resolvedApi]
  );

  return useMemo(
    () => ({
      api: resolvedApi,
      state,
      version,
      open,
      notice,
      manualError,
      busy,
      openSurface: () => setOpen(true),
      closeSurface: () => setOpen(false),
      check: () => run("check"),
      download: () => run("download"),
      install: () => run("install")
    }),
    [busy, manualError, notice, open, resolvedApi, run, state, version]
  );
}
