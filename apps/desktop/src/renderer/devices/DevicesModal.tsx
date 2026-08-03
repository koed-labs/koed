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
  shortCode: string;
  expiresAt: string;
  state:
    | "waiting"
    | "approval_required"
    | "approved"
    | "completed"
    | "expired"
    | "cancelled";
  joiningDeviceLabel: string | null;
};

type RecoveryView = {
  code: string;
  kitPath: string;
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
  onApprove,
  onCancel,
  approving
}: {
  pairing: PairingView;
  onApprove: () => void;
  onCancel: () => void;
  approving: boolean;
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

  const approvalRequired = pairing.state === "approval_required";

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
          <h3>
            {approvalRequired
              ? `${pairing.joiningDeviceLabel ?? "New device"} wants to connect`
              : pairing.state === "approved"
                ? "Device approved"
                : "Scan with your other device"}
          </h3>
          <p>
            {approvalRequired
              ? "Confirm that the short code is the same on both devices before approving."
              : pairing.state === "approved"
                ? "The other device is completing encrypted setup."
                : "Both devices must be on the same private network. This invitation can be used once."}
          </p>
          <div className="device-short-code" aria-label="Pairing short code">
            {pairing.shortCode}
          </div>
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
        <button
          className="device-secondary-button"
          disabled={approving}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        {approvalRequired ? (
          <button
            className="device-primary-button"
            disabled={approving}
            onClick={onApprove}
            type="button"
          >
            {approving ? (
              <LoaderCircle aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            Approve device
          </button>
        ) : null}
      </footer>
    </>
  );
}

export function DevicesModal({
  initialPairingLink = "",
  invoke = desktopInvoke,
  onClose
}: {
  initialPairingLink?: string;
  invoke?: Invoke;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [pairingInvitationGroupIds, setPairingInvitationGroupIds] = useState<
    string[]
  >([]);
  const [state, setState] = useState<
    "loading" | "overview" | "invite" | "join" | "joining" | "recovery"
  >("loading");
  const [pairing, setPairing] = useState<PairingView | null>(null);
  const [pairingLink, setPairingLink] = useState(initialPairingLink);
  const [joiningShortCode, setJoiningShortCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const joiningRequestId = useRef<string | null>(null);
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
    if (initialPairingLink) {
      setPairingLink(initialPairingLink);
      setState("join");
    }
  }, [initialPairingLink]);

  useEffect(() => {
    const devices = window.koedDesktop?.devices;
    if (!devices) return;
    return devices.subscribePairingProgress((progress) => {
      if (progress.requestId !== joiningRequestId.current) return;
      setJoiningShortCode(progress.shortCode);
    });
  }, []);

  const beginInvitation = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{
        ok: boolean;
        pairing?: PairingView;
        error?: string;
      }>("personal_sync_pairing_create", {
        ...(group ? { groupId: group.group_id } : {})
      });
      if (!result.ok || !result.pairing) {
        throw new Error(result.error ?? "Pairing is not configured yet.");
      }
      setPairing(result.pairing);
      setState("invite");
      void invoke<{ pairing?: PairingView }>("personal_sync_pairing_wait", {
        id: result.pairing.id
      })
        .then((waiting) => {
          if (waiting.pairing) setPairing(waiting.pairing);
        })
        .catch((caught) => setError(errorMessage(caught)));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const bootstrapGroup = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{
        ok?: boolean;
        state?: string;
        error?: string;
        recoveryCode?: string;
        recoveryKitPath?: string;
      }>("personal_sync_group_bootstrap");
      if (result.state === "cancelled") return;
      if (
        result.ok !== true ||
        typeof result.recoveryCode !== "string" ||
        typeof result.recoveryKitPath !== "string"
      ) {
        throw new Error(
          result.error ?? "Koed could not set up Personal Device Sync."
        );
      }
      setRecovery({
        code: result.recoveryCode,
        kitPath: result.recoveryKitPath
      });
      setRecoveryConfirmed(false);
      setRecoveryCopied(false);
      setState("recovery");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const copyRecoveryCode = async () => {
    if (!recovery) return;
    await window.koedDesktop?.clipboard?.writeText(recovery.code);
    setRecoveryCopied(true);
  };

  const completeRecovery = async () => {
    if (!recoveryConfirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{ ok?: boolean; error?: string }>(
        "personal_sync_group_activate"
      );
      if (result.ok !== true) {
        throw new Error(
          result.error ??
            "Koed could not activate Personal Device Sync on this device."
        );
      }
      setRecovery(null);
      await load();
      setState("overview");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!pairing) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<{ pairing?: PairingView }>(
        "personal_sync_pairing_approve",
        { id: pairing.id }
      );
      if (result.pairing) setPairing(result.pairing);
      await load();
      setPairing(null);
      setState("overview");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (pairing) {
      await invoke("personal_sync_pairing_cancel", { id: pairing.id }).catch(
        () => undefined
      );
    }
    setPairing(null);
    setError(null);
    setState("overview");
  };

  const returnToOverview = () => {
    setError(null);
    setJoiningShortCode(null);
    setState("overview");
  };

  const close = async () => {
    if (
      pairing &&
      (pairing.state === "waiting" || pairing.state === "approval_required")
    ) {
      await invoke("personal_sync_pairing_cancel", { id: pairing.id }).catch(
        () => undefined
      );
    }
    onClose();
  };

  const join = async () => {
    const requestId = crypto.randomUUID();
    joiningRequestId.current = requestId;
    setJoiningShortCode(null);
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
      joiningRequestId.current = null;
      setJoiningShortCode(null);
      setState("overview");
    } catch (caught) {
      joiningRequestId.current = null;
      setJoiningShortCode(null);
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
      closeDisabled={busy || state === "recovery"}
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
          approving={busy}
          onApprove={() => void approve()}
          onCancel={() => void cancel()}
          pairing={pairing}
        />
      ) : state === "recovery" && recovery ? (
        <>
          <div className="device-recovery-content">
            <KeyRound aria-hidden="true" />
            <div>
              <h3>Save your recovery code</h3>
              <p>
                Your encrypted recovery kit was saved at the location below.
                Keep this code separately. Koed cannot restore the device group
                without both.
              </p>
              <label className="device-link-field">
                <span>Recovery code</span>
                <span>
                  <input
                    aria-label="Recovery code"
                    autoComplete="off"
                    readOnly
                    spellCheck={false}
                    value={recovery.code}
                  />
                  <button
                    aria-label="Copy recovery code"
                    className="device-icon-button"
                    onClick={() => void copyRecoveryCode()}
                    title="Copy recovery code"
                    type="button"
                  >
                    {recoveryCopied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Clipboard aria-hidden="true" />
                    )}
                  </button>
                </span>
              </label>
              <small className="device-recovery-path">{recovery.kitPath}</small>
              <label className="device-recovery-confirmation">
                <input
                  checked={recoveryConfirmed}
                  onChange={(event) =>
                    setRecoveryConfirmed(event.target.checked)
                  }
                  type="checkbox"
                />
                I saved the recovery code separately.
              </label>
            </div>
          </div>
          <footer className="device-modal-actions">
            <button
              className="device-primary-button"
              disabled={!recoveryConfirmed || busy}
              onClick={() => void completeRecovery()}
              type="button"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {busy ? "Activating" : "Done"}
            </button>
          </footer>
        </>
      ) : state === "join" || state === "joining" ? (
        <>
          <div className="device-join-content">
            <Smartphone aria-hidden="true" />
            <div>
              <h3>Join your existing devices</h3>
              <p>
                {state === "joining" && joiningShortCode
                  ? "Confirm that this code matches the connected device before it approves you."
                  : "Paste the one-time link shown on a device already connected to your Personal Memory."}
              </p>
              {state === "joining" && joiningShortCode ? (
                <div
                  aria-label="Pairing short code"
                  className="device-short-code"
                >
                  {joiningShortCode}
                </div>
              ) : null}
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
              {state === "joining" ? "Waiting for approval" : "Connect device"}
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
                  onClick={() => void beginInvitation()}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" />
                  ) : (
                    <Plus aria-hidden="true" />
                  )}
                  Pair another device
                </button>
              ) : (
                <p className="device-authority-guidance">
                  Create the next pairing link on the device that originally set
                  up this Personal Device Group.
                </p>
              )
            ) : (
              <>
                <button
                  className="device-secondary-button"
                  onClick={() => {
                    setError(null);
                    setState("join");
                  }}
                  type="button"
                >
                  <Laptop aria-hidden="true" />
                  Join with link
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
