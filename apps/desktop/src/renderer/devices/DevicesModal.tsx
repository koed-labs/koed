import { DeviceRequestPanel } from "./DeviceRequestPanel.js";
import {
  Check,
  Clipboard,
  KeyRound,
  Laptop,
  LoaderCircle,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Smartphone,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

type DeviceMember = {
  device_id: string;
  status: string;
};

type DeviceGroup = {
  group_id: string;
  members: DeviceMember[];
  policy?: { enabled?: boolean };
};

type PairingView = {
  id: string;
  url: string;
  expiresAt: string;
  state:
    | "waiting"
    | "connecting"
    | "completed"
    | "expired"
    | "cancelled"
    | "failed";
  phase?:
    | "waiting"
    | "request_received"
    | "committing"
    | "awaiting_joiner"
    | "completed";
  joiningDeviceLabel: string | null;
};

type Invoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>;

const desktopInvoke: Invoke = async (command, args) => {
  if (!window.koedDesktop?.invoke) {
    throw new Error("Koed Desktop device controls are unavailable.");
  }
  return await window.koedDesktop.invoke(command, args);
};

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error) || !error.message) {
    return "Koed could not complete device pairing.";
  }
  if (error.message.includes("PersonalMemoryBoundaryError: not_ready"))
    return "Koed’s local services are not ready. Check local health and restart Koed before setting up devices.";
  if (error.message.includes("ENOSPC"))
    return "Koed ran out of disk space. Free space and restart Koed before setting up devices.";
  return error.message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ""
  );
};

const parseGroups = (value: unknown): DeviceGroup[] => {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { groups?: unknown }).groups)
  ) {
    return [];
  }
  return (value as { groups: unknown[] }).groups.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const group = entry as Record<string, unknown>;
    if (typeof group.group_id !== "string" || !Array.isArray(group.members)) {
      return [];
    }
    const members = group.members.flatMap((member) => {
      if (!member || typeof member !== "object" || Array.isArray(member)) {
        return [];
      }
      const item = member as Record<string, unknown>;
      return typeof item.device_id === "string" &&
        typeof item.status === "string"
        ? [{ device_id: item.device_id, status: item.status }]
        : [];
    });
    return [
      {
        group_id: group.group_id,
        members,
        ...(group.policy &&
        typeof group.policy === "object" &&
        !Array.isArray(group.policy)
          ? { policy: group.policy as { enabled?: boolean } }
          : {})
      }
    ];
  });
};

const parsePairingInvitationGroupIds = (value: unknown): string[] => {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(
      (value as { pairing_invitation_group_ids?: unknown })
        .pairing_invitation_group_ids
    )
  ) {
    return [];
  }
  return (
    value as { pairing_invitation_group_ids: unknown[] }
  ).pairing_invitation_group_ids.filter(
    (groupId): groupId is string => typeof groupId === "string"
  );
};

const deviceName = (deviceId: string, index: number): string =>
  `Device ${index + 1} · ${deviceId.slice(0, 7)}`;

function ModalFrame({
  children,
  onClose,
  closeDisabled = false,
  title
}: {
  children: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  title: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabled) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [closeDisabled, onClose]);

  return (
    <div
      aria-label={title}
      aria-modal="true"
      className="device-modal-backdrop"
      role="dialog"
    >
      <div className="device-modal" ref={panelRef} tabIndex={-1}>
        <header className="device-modal-header">
          <div>
            <MonitorSmartphone aria-hidden="true" />
            <h2>{title}</h2>
          </div>
          <button
            aria-label="Close Devices"
            className="device-icon-button"
            disabled={closeDisabled}
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function PairingInvitation({
  pairing,
  onCancel,
  onRetry,
  cancelling,
  retrying
}: {
  pairing: PairingView;
  onCancel: () => void;
  onRetry?: () => void;
  cancelling: boolean;
  retrying: boolean;
}) {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(pairing.url, {
          errorCorrectionLevel: "H",
          margin: 2,
          width: 224,
          color: { dark: "#111315", light: "#ffffff" }
        })
      )
      .then((value) => {
        if (current) setQrCode(value);
      })
      .catch(() => {
        if (current) setQrFailed(true);
      });
    return () => {
      current = false;
    };
  }, [pairing.url]);

  const copy = async () => {
    await window.koedDesktop?.clipboard?.writeText(pairing.url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const isActive =
    pairing.state === "waiting" || pairing.state === "connecting";
  const copyByState = {
    waiting: {
      title: "Scan with your other device",
      description:
        "Both devices must be reachable on the same private network or Tailscale network. This invitation can be used once."
    },
    connecting: {
      title: `${pairing.joiningDeviceLabel ?? "New device"} is connecting`,
      description:
        pairing.phase === "committing"
          ? "Secure membership commit is in progress. Cancellation is no longer available."
          : pairing.phase === "awaiting_joiner"
            ? "Waiting for joining device to activate its encrypted replica."
            : "Encrypted setup is in progress."
    },
    completed: {
      title: "Connected",
      description: "Your other device is now connected to Personal Memory."
    },
    expired: {
      title: "Pairing invitation expired",
      description: "Create a new invitation to connect another device."
    },
    cancelled: {
      title: "Pairing invitation cancelled",
      description: "Create a new invitation to connect another device."
    },
    failed: {
      title: "Pairing failed",
      description: "Create a new invitation and try again."
    }
  }[pairing.state];

  return (
    <>
      <div className="device-pairing-content">
        <div className="device-qr-frame" aria-label="Device pairing QR code">
          {qrCode ? (
            <img alt="Scan to pair another Koed device" src={qrCode} />
          ) : qrFailed ? (
            <span>Use the pairing link</span>
          ) : (
            <LoaderCircle aria-label="Creating QR code" />
          )}
        </div>
        <div className="device-pairing-copy">
          <h3>{copyByState.title}</h3>
          <p>{copyByState.description}</p>
          <label className="device-link-field">
            <span>Pairing link</span>
            <span>
              <input readOnly value={pairing.url} />
              <button
                aria-label="Copy pairing link"
                className="device-icon-button"
                onClick={() => void copy()}
                title="Copy pairing link"
                type="button"
              >
                {copied ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Clipboard aria-hidden="true" />
                )}
              </button>
            </span>
          </label>
          <small>
            Expires{" "}
            {new Date(pairing.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit"
            })}
          </small>
        </div>
      </div>
      <footer className="device-modal-actions">
        {isActive && onRetry ? (
          <button
            className="device-secondary-button"
            disabled={retrying || cancelling}
            onClick={onRetry}
            type="button"
          >
            {retrying ? <LoaderCircle aria-hidden="true" /> : null}
            Retry connection
          </button>
        ) : null}
        {isActive ? (
          <button
            className="device-secondary-button"
            disabled={cancelling}
            onClick={onCancel}
            type="button"
          >
            {cancelling ? <LoaderCircle aria-hidden="true" /> : null}
            Cancel
          </button>
        ) : null}
      </footer>
    </>
  );
}

export function DevicesModal({
  initialPairingLink = "",
  invoke = desktopInvoke,
  onClose,
  onPairingLinkConsumed
}: {
  initialPairingLink?: string;
  invoke?: Invoke;
  onClose: () => void;
  onPairingLinkConsumed?: () => void;
}) {
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [pairingInvitationGroupIds, setPairingInvitationGroupIds] = useState<
    string[]
  >([]);
  const [state, setState] = useState<
    "loading" | "overview" | "invite" | "join" | "joining" | "request" | "add"
  >("loading");
  const [pairing, setPairing] = useState<PairingView | null>(null);
  const [pairingWaitFailed, setPairingWaitFailed] = useState(false);
  const [pairingLink, setPairingLink] = useState(initialPairingLink);
  const [joiningProgress, setJoiningProgress] = useState<
    "connecting" | "completed" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const joiningRequestId = useRef<string | null>(null);
  const activePairingId = useRef<string | null>(null);
  const group = groups[0] ?? null;
  const canCreateInvitation = Boolean(
    group && pairingInvitationGroupIds.includes(group.group_id)
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await invoke("personal_sync_status");
      setGroups(parseGroups(result));
      setPairingInvitationGroupIds(parsePairingInvitationGroupIds(result));
      setState((current) =>
        current === "loading"
          ? initialPairingLink
            ? "join"
            : "overview"
          : current
      );
    } catch (caught) {
      setError(errorMessage(caught));
      setState((current) =>
        current === "loading"
          ? initialPairingLink
            ? "join"
            : "overview"
          : current
      );
    }
  }, [initialPairingLink, invoke]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!initialPairingLink) return;
    setPairingLink(initialPairingLink);
    setState("join");
    onPairingLinkConsumed?.();
  }, [initialPairingLink, onPairingLinkConsumed]);

  useEffect(() => {
    if (
      !pairing ||
      ["completed", "expired", "cancelled", "failed"].includes(pairing.state)
    ) {
      return;
    }
    const poll = () => {
      void invoke<{ pairing?: PairingView }>("personal_sync_pairing_status", {
        id: pairing.id
      })
        .then((result) => {
          if (activePairingId.current !== pairing.id || !result.pairing) return;
          setPairing(result.pairing);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(poll, 500);
    return () => window.clearInterval(timer);
  }, [invoke, pairing]);

  useEffect(() => {
    const devices = window.koedDesktop?.devices;
    if (!devices) return;
    return devices.subscribePairingProgress((progress) => {
      if (progress.requestId !== joiningRequestId.current) return;
      setJoiningProgress(progress.state);
    });
  }, []);

  const waitForInvitation = async (id: string): Promise<void> => {
    const result = await invoke<{ pairing?: PairingView }>(
      "personal_sync_pairing_wait",
      { id }
    );
    if (activePairingId.current !== id || !result.pairing) return;
    setPairing(result.pairing);
    if (result.pairing.state === "completed") {
      setPairingWaitFailed(false);
      activePairingId.current = null;
      await load();
      return;
    }
    if (
      result.pairing.state === "waiting" ||
      result.pairing.state === "connecting"
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      if (activePairingId.current === id) await waitForInvitation(id);
      return;
    }
    activePairingId.current = null;
    if (result.pairing.state === "failed") {
      setError("Pairing enrollment failed.");
    }
  };

  const requestConnected = useCallback(() => {
    void load();
    setState("overview");
  }, [load]);

  const bootstrapGroup = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{ ok?: boolean; error?: string }>(
        "personal_sync_group_bootstrap"
      );
      if (result.ok !== true)
        throw new Error(
          result.error ?? "Koed could not set up Personal Device Sync."
        );
      await load();
      setState("overview");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancelPairing = async (): Promise<boolean> => {
    const currentPairing = pairing;
    if (
      !currentPairing ||
      (currentPairing.state !== "waiting" &&
        currentPairing.state !== "connecting")
    ) {
      return true;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{ ok?: boolean; state?: string }>(
        "personal_sync_pairing_cancel",
        { id: currentPairing.id }
      );
      if (
        result.ok !== true ||
        !["cancelled", "expired", "failed"].includes(result.state ?? "")
      ) {
        throw new Error("Koed could not confirm pairing cancellation.");
      }
      activePairingId.current = null;
      setPairing(null);
      setState("overview");
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    void cancelPairing();
  };

  const returnToOverview = () => {
    setError(null);
    setJoiningProgress(null);
    setPairingLink("");
    setState("overview");
  };

  const close = async () => {
    if (pairing) {
      const cancelled = await cancelPairing();
      if (!cancelled) return;
    }
    onClose();
  };

  const join = async () => {
    const requestId = crypto.randomUUID();
    joiningRequestId.current = requestId;
    setJoiningProgress(null);
    setBusy(true);
    setError(null);
    setState("joining");
    try {
      await invoke("personal_sync_pairing_redeem", {
        url: pairingLink,
        requestId,
        deviceLabel: navigator.userAgent.includes("Windows")
          ? "Windows device"
          : navigator.userAgent.includes("Mac")
            ? "Mac device"
            : "Linux device"
      });
      await load();
      setPairingLink("");
      joiningRequestId.current = null;
      setJoiningProgress(null);
      setState("overview");
    } catch (caught) {
      joiningRequestId.current = null;
      setJoiningProgress(null);
      setError(errorMessage(caught));
      setState("join");
    } finally {
      setBusy(false);
    }
  };

  const activeMembers = useMemo(
    () => group?.members.filter((member) => member.status === "active") ?? [],
    [group]
  );

  return (
    <ModalFrame
      closeDisabled={busy}
      onClose={() => void close()}
      title="Devices"
    >
      {error ? (
        <div className="device-error" role="alert">
          {error}
        </div>
      ) : null}

      {state === "loading" ? (
        <div className="device-loading" role="status">
          <LoaderCircle aria-hidden="true" />
          Loading your devices
        </div>
      ) : state === "invite" && pairing ? (
        <PairingInvitation
          cancelling={busy}
          onCancel={() => void cancel()}
          onRetry={
            pairingWaitFailed
              ? () => {
                  const id = activePairingId.current;
                  if (!id) return;
                  setPairingWaitFailed(false);
                  setError(null);
                  void waitForInvitation(id).catch((caught) => {
                    if (activePairingId.current === id) {
                      setPairingWaitFailed(true);
                      setError(errorMessage(caught));
                    }
                  });
                }
              : undefined
          }
          pairing={pairing}
          retrying={false}
        />
      ) : state === "request" || state === "add" ? (
        <DeviceRequestPanel
          mode={state === "request" ? "join" : "add"}
          invoke={invoke}
          onBack={() => setState("overview")}
          onConnected={requestConnected}
        />
      ) : state === "join" || state === "joining" ? (
        <>
          <div className="device-join-content">
            <Smartphone aria-hidden="true" />
            <div>
              <h3>Join your existing devices</h3>
              <p>
                {state === "joining"
                  ? joiningProgress === "completed"
                    ? "Connected. Finishing encrypted setup…"
                    : "Connecting to your existing devices…"
                  : "Paste the one-time link shown on a device already connected to your Personal Memory."}
              </p>
            </div>
            <label className="device-join-field">
              <span>Pairing link</span>
              <input
                autoFocus
                disabled={state === "joining"}
                onChange={(event) => setPairingLink(event.target.value)}
                placeholder="http://192.168…/pair/…"
                value={pairingLink}
              />
            </label>
          </div>
          <footer className="device-modal-actions">
            <button
              className="device-secondary-button"
              disabled={state === "joining"}
              onClick={returnToOverview}
              type="button"
            >
              Back
            </button>
            <button
              className="device-primary-button"
              disabled={!pairingLink.trim() || state === "joining"}
              onClick={() => void join()}
              type="button"
            >
              {state === "joining" ? (
                <LoaderCircle aria-hidden="true" />
              ) : (
                <Laptop aria-hidden="true" />
              )}
              {state === "joining" ? "Connecting…" : "Connect device"}
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="device-overview">
            <div className="device-overview-heading">
              <div>
                <h3>Your Personal devices</h3>
                <p>
                  Each connected device receives an encrypted local replica of
                  every eligible closed Captured Session. Koed rebuilds its
                  Personal Memory locally.
                </p>
              </div>
              <button
                aria-label="Refresh devices"
                className="device-icon-button"
                onClick={() => void load()}
                title="Refresh devices"
                type="button"
              >
                <RefreshCw aria-hidden="true" />
              </button>
            </div>
            <div className="device-list">
              {activeMembers.length ? (
                activeMembers.map((member, index) => (
                  <div className="device-row" key={member.device_id}>
                    <span>
                      {index % 2 === 0 ? (
                        <Laptop aria-hidden="true" />
                      ) : (
                        <Smartphone aria-hidden="true" />
                      )}
                    </span>
                    <div>
                      <strong>{deviceName(member.device_id, index)}</strong>
                      <small>Connected</small>
                    </div>
                    <Check aria-label="Active" />
                  </div>
                ))
              ) : (
                <div className="device-empty-state">
                  <MonitorSmartphone aria-hidden="true" />
                  <div>
                    <strong>No Personal Device Group yet</strong>
                    <span>
                      Join an existing device, or complete secure first-device
                      setup before inviting another one.
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
          <footer className="device-modal-actions device-overview-actions">
            {group ? (
              canCreateInvitation ? (
                <button
                  className="device-primary-button"
                  disabled={busy}
                  onClick={() => setState("add")}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" />
                  ) : (
                    <Plus aria-hidden="true" />
                  )}
                  Add device
                </button>
              ) : (
                <p className="device-authority-guidance">
                  Add devices from the installation that originally created this
                  Personal Device Group.
                </p>
              )
            ) : (
              <>
                <button
                  className="device-secondary-button"
                  onClick={() => {
                    setError(null);
                    setState("request");
                  }}
                  type="button"
                >
                  <Laptop aria-hidden="true" />
                  Connect to an existing device
                </button>
                <button
                  className="device-primary-button"
                  disabled={busy}
                  onClick={() => void bootstrapGroup()}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" />
                  ) : (
                    <KeyRound aria-hidden="true" />
                  )}
                  Set up device sync
                </button>
              </>
            )}
          </footer>
        </>
      )}
    </ModalFrame>
  );
}
