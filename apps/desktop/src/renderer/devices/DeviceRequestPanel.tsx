import { useEffect, useState } from "react";

type Invoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>;
type RequestView = {
  id: string;
  label: string;
  expiresAt: string;
  state: string;
  link?: string;
};

export function DeviceRequestPanel({
  mode,
  invoke,
  onBack,
  onConnected
}: {
  mode: "join" | "add";
  invoke: Invoke;
  onBack: () => void;
  onConnected: () => void;
}) {
  const [request, setRequest] = useState<RequestView | null>(null);
  const [url, setUrl] = useState("");
  const [review, setReview] = useState<{
    id: string;
    label: string;
    expiresAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (mode !== "join") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await invoke<RequestView>(
          "personal_sync_request_status"
        );
        if (!active) return;
        setRequest((previous) => ({
          ...result,
          ...(previous?.link && result.state === "waiting"
            ? { link: previous.link }
            : {})
        }));
        if (result.state === "connected") {
          onConnected();
          return;
        }
        if (["expired", "cancelled", "failed"].includes(result.state)) return;
        timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (active)
          setError(
            "Koed stopped or lost its connection. Restart Koed and open Devices again to check this request."
          );
      }
    };
    void invoke<RequestView>("personal_sync_request_create")
      .then((result) => {
        if (!active) return;
        setRequest(result);
        timer = setTimeout(() => void poll(), 1000);
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not create a device request."
          );
      });
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [mode, invoke, onConnected]);

  const accept = async () => {
    setError(null);
    setBusy(true);
    try {
      if (!review) {
        const result = await invoke<{
          id: string;
          label: string;
          expiresAt: string;
        }>("personal_sync_request_review", { url });
        setReview(result);
        setUrl("");
      } else {
        const result = await invoke<{ ok: boolean }>(
          "personal_sync_request_accept",
          { id: review.id }
        );
        if (!result.ok) throw new Error("Device enrollment did not complete.");
        onConnected();
      }
    } catch (caught) {
      setReview(null);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not connect the device."
      );
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await invoke("personal_sync_request_cancel");
      onBack();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not cancel the request."
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="device-join-content">
        <h3>
          {mode === "join"
            ? "Connect to an existing device"
            : review
              ? `Add ${review.label}?`
              : "Add a device"}
        </h3>
        {error ? <p role="alert">{error}</p> : null}
        {mode === "join" ? (
          <>
            <p>
              On the device that created your Personal Device Group, open
              Devices → Add device and paste this request link. Keep both
              devices on the same LAN or Tailscale network.
            </p>
            {request?.link ? (
              <label className="device-link-field">
                <span>Device request link</span>
                <input
                  aria-label="Device request link"
                  readOnly
                  autoComplete="off"
                  value={request.link}
                />
                <button
                  type="button"
                  onClick={() => {
                    void window.koedDesktop?.clipboard
                      ?.writeText(request.link!)
                      .then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </button>
              </label>
            ) : null}
            <p role="status">
              {request
                ? request.state === "waiting"
                  ? "Waiting for approval on your existing device."
                  : request.state === "connecting"
                    ? "Connecting and preparing your local replica…"
                    : `Request ${request.state}.`
                : "Preparing your device request…"}
            </p>
            {request ? (
              <small>
                Expires {new Date(request.expiresAt).toLocaleTimeString()}.
              </small>
            ) : null}
          </>
        ) : review ? (
          <p>
            This device will receive an encrypted replica of eligible future
            closed Captured Sessions. Confirm that you copied this request from
            the device you want to add.
          </p>
        ) : (
          <>
            <p>
              Copy the request link from the other Electron app, or run{" "}
              <code>koed-server pair</code> on a headless device.
            </p>
            <label className="device-link-field">
              <span>Device request link</span>
              <input
                aria-label="Device request link"
                autoComplete="off"
                spellCheck={false}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://192.168…/device-request/…"
              />
            </label>
          </>
        )}
      </div>
      <footer className="device-modal-actions">
        <button
          type="button"
          className="device-secondary-button"
          disabled={busy}
          onClick={onBack}
        >
          Back
        </button>
        {mode === "join" ? (
          <button
            type="button"
            className="device-secondary-button"
            disabled={busy || !request || request.state !== "waiting"}
            onClick={() => void cancel()}
          >
            Cancel request
          </button>
        ) : (
          <button
            type="button"
            className="device-primary-button"
            disabled={busy || (!review && !url.trim())}
            onClick={() => void accept()}
          >
            {busy ? "Connecting…" : review ? "Add device" : "Review device"}
          </button>
        )}
      </footer>
    </>
  );
}
