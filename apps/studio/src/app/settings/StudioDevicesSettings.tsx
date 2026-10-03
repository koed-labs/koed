"use client";

import { Monitor, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { DevicesModal } from "../../../.desktop-ui/index.js";
import "../../../../desktop/src/renderer/devices/devices.css";
import { useStudioDesktopAvailability } from "./StudioSettingsComputerContext";

export function StudioDevicesSettings() {
  const [open, setOpen] = useState(false);
  const [pairingLink, setPairingLink] = useState("");
  const desktopAvailability = useStudioDesktopAvailability();
  const nativeDesktop = desktopAvailability === true;

  useEffect(() => {
    const devices = window.koedDesktop?.devices;
    if (!devices) return;
    let active = true;
    const unsubscribe = devices.subscribePairingLinks((url) => {
      if (!active) return;
      setPairingLink(url);
      setOpen(true);
    });
    void devices.consumePairingLink().then((url) => {
      if (active && url) {
        setPairingLink(url);
        setOpen(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return (
    <section
      className="mt-8 border-b border-border pb-8"
      aria-labelledby="devices-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            id="devices-heading"
            className="text-sm font-medium text-foreground-secondary"
          >
            Devices
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted">
            Connect and manage computers that can run Koed and AI Clients.
          </p>
        </div>
        {nativeDesktop ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border px-3 text-xs text-foreground-secondary hover:border-border-strong hover:text-foreground"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            Manage devices
          </button>
        ) : null}
      </div>

      {desktopAvailability === null ? (
        <p className="mt-4 text-xs text-muted">Checking Desktop connection…</p>
      ) : nativeDesktop ? (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-surface/40 p-4 text-xs leading-5 text-muted">
          <Monitor aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          Setup, pairing, and repair are handled by Koed Studio Desktop on each
          computer.
        </p>
      ) : (
        <p className="mt-4 rounded-lg border border-border bg-surface/40 p-4 text-xs leading-5 text-muted">
          To connect a computer, open Koed Studio Desktop on that computer and
          choose Settings → Devices → Manage devices. Install or repair Koed
          locally there, then use the device picker in Chat to choose its
          verified AI Client and model.
        </p>
      )}

      {open && nativeDesktop ? (
        <>
          <DevicesModal
            initialPairingLink={pairingLink}
            onPairingLinkConsumed={() => setPairingLink("")}
            onClose={() => {
              setOpen(false);
              setPairingLink("");
            }}
          />
        </>
      ) : null}
    </section>
  );
}
