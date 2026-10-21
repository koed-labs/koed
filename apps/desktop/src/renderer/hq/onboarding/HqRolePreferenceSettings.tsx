import { useEffect, useRef, useState } from "react";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import {
  readHqOnboarding,
  writeHqOnboarding,
  type HqOnboardingRecord
} from "./onboarding-preference.js";
import { rememberHqPreference } from "./remember-preference.js";

const labels = {
  software: "Building software",
  studying: "Studying",
  other: "Something else"
} as const;

export function HqRolePreferenceSettings({
  authorityKey,
  personalMemoryApi
}: {
  authorityKey?: string;
  personalMemoryApi?: PersonalDesktopApi;
}) {
  const divider = authorityKey?.indexOf("|") ?? -1;
  const ownerId = divider < 0 ? "" : authorityKey!.slice(0, divider);
  const profileKey = divider < 0 ? "" : authorityKey!.slice(divider + 1);
  const [record, setRecord] = useState<HqOnboardingRecord>(() =>
    ownerId ? readHqOnboarding(ownerId, profileKey) : readHqOnboarding("", "")
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef(authorityKey);
  current.current = authorityKey;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save = (value: HqOnboardingRecord) => {
    if (!ownerId || !writeHqOnboarding(ownerId, profileKey, value))
      throw new Error("Preference could not be saved for this profile.");
    setRecord(value);
  };
  const remember = async () => {
    const isCurrent = () => mounted.current && current.current === authorityKey;
    setNotice(null);
    setBusy(true);
    try {
      if (!personalMemoryApi || !window.koedDesktop?.curatedMemory)
        throw new Error("Personal Memory review is unavailable.");
      const next = {
        ...record,
        remember: true,
        rememberRequestId: record.rememberRequestId ?? crypto.randomUUID()
      };
      save(next);
      const result = await rememberHqPreference({
        record: next,
        personalMemoryApi,
        curatedMemoryApi: window.koedDesktop.curatedMemory,
        save,
        current: isCurrent
      });
      if (!isCurrent()) return;
      setNotice(
        result.kind === "projection_pending"
          ? "Your Personal Note is saved. Retry after its source finishes processing."
          : result.kind === "reviewed"
            ? "Your preference proposal was already reviewed."
            : "Proposed to Me memory. Your AI Client reviews it before it becomes Memory."
      );
    } catch (cause) {
      if (isCurrent())
        setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Onboarding preference"
      className="hq-onboarding-settings"
    >
      <h3 className="hq-settings__eyebrow">Your starting point</h3>
      <p>
        This changes examples and source suggestions. It does not change your
        Agent's permissions.
      </p>
      <label>
        What do you mostly use Koed for?{" "}
        <select
          disabled={!ownerId || busy}
          value={record.role}
          onChange={(event) => {
            const role = event.target.value as HqOnboardingRecord["role"];
            save({
              ...record,
              role,
              roleAnswered: true,
              remember: false,
              rememberRequestId: null,
              noteId: null,
              memoryEventId: null,
              proposalId: null
            });
            setNotice(null);
          }}
        >
          {Object.entries(labels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!ownerId || busy || Boolean(record.proposalId)}
        onClick={() => void remember()}
      >
        {busy
          ? "Saving…"
          : record.noteId && !record.proposalId
            ? "Retry Memory review"
            : "Remember this in Me memory"}
      </button>
      {record.proposalId ? (
        <p role="status">Preference proposal sent for AI Client review.</p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
