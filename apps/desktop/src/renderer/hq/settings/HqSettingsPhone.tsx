import { useEffect, useState } from "react";
import type {
  PhoneGatewayDesktopApi,
  PhoneGatewayStatusView
} from "../../../ipc/phone-gateway-protocol.js";
import { HqSettingRow } from "./HqSettings.js";

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      })
    : "Not yet";

/**
 * Settings › Phone: turn phone access on, pair the Koed phone app with a QR
 * code, and see or remove paired phones.
 */
export function HqSettingsPhone({ api }: { api?: PhoneGatewayDesktopApi }) {
  const [status, setStatus] = useState<PhoneGatewayStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api
      .command({ operation: "status" })
      .then((value) => active && setStatus(value))
      .catch(() => active && setError("Phone access could not be read."));
    const stop = api.onChange((value) => active && setStatus(value));
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  const link = status?.pairing?.link ?? null;
  useEffect(() => {
    if (!link) {
      setQrCode(null);
      return;
    }
    let current = true;
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(link, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 224,
          color: { dark: "#111315", light: "#ffffff" }
        })
      )
      .then((value) => current && setQrCode(value))
      .catch(() => current && setQrCode(null));
    return () => {
      current = false;
    };
  }, [link]);

  if (!api) return null;

  const run = (request: Parameters<PhoneGatewayDesktopApi["command"]>[0]) => {
    setBusy(true);
    setError(null);
    void api
      .command(request)
      .then(setStatus)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "That didn't work.")
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <HqSettingRow
        title="Phone access"
        description="Let the Koed phone app talk to your Chief of Staff, answer approvals and run jobs on this Mac. The phone must be on the same Wi-Fi or Tailscale network."
      >
        <input
          className="hq-settings__switch"
          role="switch"
          aria-label="Phone access"
          type="checkbox"
          checked={status?.enabled ?? false}
          disabled={!status || busy}
          onChange={(event) =>
            run({ operation: "enable", enabled: event.currentTarget.checked })
          }
        />
      </HqSettingRow>
      {status?.enabled ? (
        <HqSettingRow
          title="Network"
          description={
            status.error ??
            (status.listening.length
              ? `Listening on ${status.listening.map((url) => url.replace(/^http:\/\//u, "")).join(", ")}. On Wi-Fi, traffic between the phone and this Mac isn't encrypted; Tailscale encrypts it.`
              : "Starting…")
          }
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => run({ operation: "restart" })}
          >
            Look again
          </button>
        </HqSettingRow>
      ) : null}
      {status?.enabled && status.listening.length ? (
        <section className="hq-settings__group" aria-label="Pair a phone">
          <h3>Pair a phone</h3>
          {status.pairing ? (
            <div className="hq-settings__phone-pairing">
              {qrCode ? (
                <img
                  src={qrCode}
                  width={224}
                  height={224}
                  alt="Pairing QR code for the Koed phone app"
                />
              ) : null}
              <div>
                <p>
                  In the Koed app on your phone, choose{" "}
                  <strong>Pair with your Mac</strong> and scan this code.
                </p>
                <p>
                  Or type <strong>{status.pairing.addresses[0]}</strong> and the
                  code{" "}
                  <strong>
                    {status.pairing.code.slice(0, 3)}{" "}
                    {status.pairing.code.slice(3)}
                  </strong>
                  .
                </p>
                <p>
                  Works once, until{" "}
                  {new Date(status.pairing.expiresAt).toLocaleTimeString(
                    undefined,
                    { timeStyle: "short" }
                  )}
                  .
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run({ operation: "cancelPairing" })}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => run({ operation: "pair" })}
            >
              Show pairing code
            </button>
          )}
        </section>
      ) : null}
      {status?.phones.length ? (
        <section className="hq-settings__group" aria-label="Paired phones">
          <h3>Paired phones</h3>
          {status.phones.map((phone) => (
            <HqSettingRow
              key={phone.id}
              title={phone.name}
              description={`${phone.connected ? "Connected now" : `Last seen: ${when(phone.lastSeenAt)}`} · Paired ${when(phone.pairedAt)}${phone.push ? " · Notifications on" : ""}`}
            >
              <button
                type="button"
                disabled={busy}
                onClick={() => run({ operation: "revoke", phoneId: phone.id })}
              >
                Remove
              </button>
            </HqSettingRow>
          ))}
        </section>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
