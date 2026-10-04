"use client";

import { useEffect, useRef, useState } from "react";

function validScopeKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separator = value.lastIndexOf("|");
  return separator > 0 && Boolean(value.slice(separator + 1).trim());
}

export function useVerifiedPersonalScope(
  homeScopeKey?: string | null,
  enabled = true
) {
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const sequenceRef = useRef(0);
  const mismatchRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let controller: AbortController | null = null;
    const verify = () => {
      const sequence = ++sequenceRef.current;
      controller?.abort();
      controller = new AbortController();
      const requestController = controller;
      setScopeKey(null);
      const load = async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const response = await fetch("/studio-api/personal-scope", {
              headers: { Accept: "application/json" },
              cache: "no-store",
              signal: requestController.signal
            });
            if (!response.ok) throw new Error("Personal scope unavailable");
            const payload: unknown = await response.json();
            const candidate =
              payload && typeof payload === "object"
                ? (payload as { scopeKey?: unknown }).scopeKey
                : null;
            if (
              active &&
              sequence === sequenceRef.current &&
              validScopeKey(candidate)
            ) {
              setScopeKey(candidate);
              return;
            }
            throw new Error("Personal scope unavailable");
          } catch {
            if (
              !active ||
              sequence !== sequenceRef.current ||
              requestController.signal.aborted
            )
              return;
            if (attempt < 2) {
              await new Promise((resolve) =>
                setTimeout(resolve, attempt === 0 ? 300 : 1_000)
              );
            }
          }
        }
        if (active && sequence === sequenceRef.current) setScopeKey(null);
      };
      void load();
    };
    verify();
    window.addEventListener("focus", verify);
    window.addEventListener("koed:personal-account-changed", verify);
    return () => {
      active = false;
      sequenceRef.current += 1;
      controller?.abort();
      window.removeEventListener("focus", verify);
      window.removeEventListener("koed:personal-account-changed", verify);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (!homeScopeKey) {
      mismatchRef.current = null;
      return;
    }
    if (!scopeKey) return;
    if (homeScopeKey === scopeKey) {
      mismatchRef.current = null;
      return;
    }
    const mismatch = `${homeScopeKey}\n${scopeKey}`;
    if (mismatchRef.current === mismatch) return;
    mismatchRef.current = mismatch;
    window.dispatchEvent(new Event("koed:personal-account-changed"));
  }, [enabled, homeScopeKey, scopeKey]);

  if (!enabled) return homeScopeKey ?? null;
  return homeScopeKey && scopeKey && homeScopeKey !== scopeKey
    ? null
    : scopeKey;
}
