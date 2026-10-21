import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "@koed/shared/agent-contract";
import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";
import type { DesktopApi } from "../../../types.js";
import type { CuratedMemoryDesktopApi } from "../../../ipc/curated-memory-protocol.js";
import { DesktopStatusStore } from "../../services/desktop-commands.js";
import { HqSettingsAgents } from "../settings/HqSettingsAgents.js";
import { Pixelkin } from "../agents/Pixelkin.js";
import {
  readHqOnboarding,
  writeHqOnboarding,
  type HqOnboardingRecord
} from "./onboarding-preference.js";
import { rememberHqPreference } from "./remember-preference.js";
import "./hq-onboarding.css";

const roles = [
  [
    "software",
    "Building software",
    "Start with a code Project and connect a repository."
  ],
  [
    "studying",
    "Studying",
    "Start with a course Project and add a study source."
  ],
  [
    "other",
    "Something else",
    "Start with a blank Project and add what matters to you."
  ]
] as const;
const shapes = ["roundedBox", "sphere", "cuboid", "capsule"] as const;
const colors = ["#8c76d7", "#db8f72", "#69a7a3", "#d2ac64"] as const;

const chooseRole = (
  record: HqOnboardingRecord,
  role: HqOnboardingRecord["role"]
): HqOnboardingRecord => ({
  ...record,
  role,
  roleAnswered: true,
  ...(role !== record.role
    ? {
        remember: false,
        rememberRequestId: null,
        noteId: null,
        memoryEventId: null,
        proposalId: null
      }
    : {})
});

export function HqOnboarding({
  ownerId,
  profileKey,
  agentsApi,
  localAiClients,
  personalMemoryApi,
  curatedMemoryApi,
  onComplete
}: {
  ownerId: string;
  profileKey: string;
  agentsApi?: DesktopApi["agents"];
  localAiClients?: DesktopApi["localAiClients"];
  personalMemoryApi?: PersonalDesktopApi;
  curatedMemoryApi?: CuratedMemoryDesktopApi;
  onComplete: (record: HqOnboardingRecord) => void;
}) {
  const [record, setRecord] = useState(() => ({
    ...readHqOnboarding(ownerId, profileKey),
    lookSeed:
      readHqOnboarding(ownerId, profileKey).lookSeed || crypto.randomUUID()
  }));
  const [statusStore] = useState(() => new DesktopStatusStore());
  const [connectedInstance, setConnectedInstance] = useState<string | null>(
    null
  );
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const save = useCallback(
    (next: HqOnboardingRecord) => {
      if (!writeHqOnboarding(ownerId, profileKey, next))
        throw new Error("Onboarding could not be saved on this device.");
      setRecord(next);
    },
    [ownerId, profileKey]
  );
  const checkClient = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      if (!localAiClients)
        throw new Error("AI Client settings are unavailable.");
      const response = await localAiClients.refresh();
      if (!alive.current) return;
      const choice = response.readModel.defaults.conversations;
      const instance = response.readModel.instances.find(
        (item) =>
          item.enabled &&
          item.instanceId === choice.assignment?.ai_client_instance_id &&
          item.driverId === choice.assignment.provider
      );
      setConnectedInstance(
        choice.available && instance ? instance.instanceId : null
      );
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [localAiClients]);
  useEffect(() => {
    void checkClient();
  }, [checkClient]);
  const selected = roles.find(([id]) => id === record.role)!;
  const preview: Pick<Agent, "id" | "name" | "look"> = {
    id: "00000000-0000-4000-8000-000000000506",
    name: record.chiefName.trim() || "Your Chief of Staff",
    look: {
      pixelkin: {
        seed: record.lookSeed,
        body: { shape: record.lookShape },
        palette: { base: record.lookColor }
      }
    }
  };
  const finish = async () => {
    if (busy) return;
    setError(null);
    setNotice(null);
    const name = record.chiefName.trim();
    if (!name || name.length > 120) {
      setError("Give your Chief of Staff a name.");
      return;
    }
    if (!connectedInstance || !agentsApi) {
      setError("Connect an AI Client before finishing your Chief of Staff.");
      return;
    }
    setBusy(true);
    try {
      const chief = await agentsApi.ensureChief();
      if (!alive.current) return;
      if (!chief.isChiefOfStaff || chief.ownerUserId !== ownerId)
        throw new Error("Chief of Staff owner identity changed.");
      const patched = await agentsApi.patch(chief.id, {
        name,
        look: preview.look,
        ...(chief.aiClientInstanceId !== connectedInstance
          ? { aiClientInstanceId: connectedInstance }
          : {})
      });
      if (!alive.current) return;
      if (!patched.isChiefOfStaff || patched.ownerUserId !== ownerId)
        throw new Error("Chief of Staff owner identity changed.");
      let next = record;
      if (record.remember) {
        if (!personalMemoryApi || !curatedMemoryApi)
          throw new Error("Personal Memory review is unavailable.");
        const result = await rememberHqPreference({
          record,
          personalMemoryApi,
          curatedMemoryApi,
          save,
          current: () => alive.current
        });
        if (!alive.current) return;
        next = result.record;
        if (result.kind === "projection_pending")
          setNotice(
            "Your preference Note is saved. Memory review will be available when its source finishes processing; retry in Settings."
          );
        else if (result.kind === "reviewed")
          setNotice("Your preference has already been reviewed in Me memory.");
        else
          setNotice(
            "Your preference was proposed to Me memory. An AI Client still reviews it before it becomes Memory."
          );
      }
      next = { ...next, completed: true, chiefName: name };
      save(next);
      onComplete(next);
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="hq-onboarding" aria-label="Getting started with Koed">
      <div className="hq-onboarding__body">
        <nav className="hq-onboarding__steps" aria-label="Setup progress">
          <span
            className="hq-onboarding__step"
            aria-current={!record.roleAnswered ? "step" : undefined}
          >
            <i>1</i> Your starting point
          </span>
          <span className="hq-onboarding__step-line" aria-hidden="true" />
          <span
            className="hq-onboarding__step"
            aria-current={record.roleAnswered ? "step" : undefined}
          >
            <i>2</i> Your agent
          </span>
        </nav>
        <div className="hq-onboarding__message">
          <div className="hq-onboarding__avatar">
            <Pixelkin agent={preview} size={32} />
          </div>
          <div className="hq-onboarding__message-content">
            <p className="hq-onboarding__speaker">Your Chief of Staff</p>
            {!record.roleAnswered ? (
              <section aria-labelledby="hq-onboarding-role-title">
                <p>Hi, welcome to Koed. I’ll help you get started.</p>
                <h2 id="hq-onboarding-role-title">
                  What will you mostly use Koed for?
                </h2>
                <p className="hq-onboarding__subcopy">
                  This changes starting examples, your sample Project name, and
                  which Source to connect first. You can change it in Settings.
                </p>
                <div className="hq-onboarding__roles">
                  {roles.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className="hq-onboarding__role"
                      onClick={() => save(chooseRole(record, id))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  className="hq-onboarding__skip"
                  type="button"
                  onClick={() => save(chooseRole(record, "other"))}
                >
                  Skip · Something else
                </button>
              </section>
            ) : (
              <section aria-labelledby="hq-onboarding-chief-title">
                <h2 id="hq-onboarding-chief-title">Now, make me yours.</h2>
                <p>
                  I’ll be your Chief of Staff. Give me a name and a look.{" "}
                  {selected[2]}
                </p>
                <div className="hq-onboarding__maker">
                  <div className="hq-onboarding__preview">
                    <Pixelkin agent={preview} size={112} />
                    <strong>{record.chiefName || "Your Chief of Staff"}</strong>
                  </div>
                  <div className="hq-onboarding__controls">
                    <label className="hq-onboarding__field">
                      Name
                      <input
                        aria-label="Chief of Staff name"
                        disabled={busy}
                        maxLength={120}
                        placeholder="Give me a name"
                        autoComplete="off"
                        value={record.chiefName}
                        onChange={(event) =>
                          save({ ...record, chiefName: event.target.value })
                        }
                      />
                    </label>
                    <div
                      className="hq-onboarding__suggestions"
                      aria-label="Suggested names"
                    >
                      {["Juno", "Atlas", "Pip", "Mika", "Orbit"].map((name) => (
                        <button
                          type="button"
                          disabled={busy}
                          key={name}
                          onClick={() => save({ ...record, chiefName: name })}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    <fieldset>
                      <legend>Shape</legend>
                      <div className="hq-onboarding__shapes">
                        {shapes.map((shape) => (
                          <button
                            aria-label={`${shape} shape`}
                            disabled={busy}
                            aria-pressed={record.lookShape === shape}
                            key={shape}
                            type="button"
                            onClick={() =>
                              save({ ...record, lookShape: shape })
                            }
                          >
                            <Pixelkin
                              agent={{
                                ...preview,
                                look: {
                                  pixelkin: {
                                    seed: record.lookSeed,
                                    body: { shape },
                                    palette: { base: record.lookColor }
                                  }
                                }
                              }}
                              size={34}
                            />
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <fieldset>
                      <legend>Color</legend>
                      <div className="hq-onboarding__colors">
                        {colors.map((color) => (
                          <button
                            disabled={busy}
                            className="hq-onboarding__color"
                            style={{ backgroundColor: color }}
                            aria-label={`Choose ${color} color`}
                            aria-pressed={record.lookColor === color}
                            key={color}
                            type="button"
                            onClick={() =>
                              save({ ...record, lookColor: color })
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                    <div className="hq-onboarding__maker-footer">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          save({ ...record, lookSeed: crypto.randomUUID() })
                        }
                      >
                        Surprise me
                      </button>
                    </div>
                  </div>
                </div>
                <label className="hq-onboarding__remember">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={record.remember}
                    onChange={(event) =>
                      save({
                        ...record,
                        remember: event.target.checked,
                        rememberRequestId: event.target.checked
                          ? (record.rememberRequestId ?? crypto.randomUUID())
                          : null,
                        noteId: event.target.checked ? record.noteId : null,
                        memoryEventId: event.target.checked
                          ? record.memoryEventId
                          : null,
                        proposalId: event.target.checked
                          ? record.proposalId
                          : null
                      })
                    }
                  />
                  <span>
                    Remember my answer in Me memory. Koed saves a Personal Note
                    and asks my AI Client to review it.
                  </span>
                </label>
                {connectedInstance ? (
                  <p className="hq-onboarding__connected" role="status">
                    AI Client connected for your Chief of Staff.
                  </p>
                ) : (
                  <div className="hq-onboarding__connection">
                    <p role="status">
                      Connect an AI Client to finish. Your name and look are
                      saved as a draft.
                    </p>
                    <HqSettingsAgents
                      statusStore={statusStore}
                      localAiClients={localAiClients}
                    />
                    <button
                      type="button"
                      onClick={() => void checkClient()}
                      disabled={checking}
                    >
                      {checking ? "Checking…" : "Check connection again"}
                    </button>
                  </div>
                )}
                {error ? <p role="alert">{error}</p> : null}
                {notice ? <p role="status">{notice}</p> : null}
                <div className="hq-onboarding__footer">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => save({ ...record, roleAnswered: false })}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={busy || !connectedInstance}
                    onClick={() => void finish()}
                  >
                    {busy ? "Saving…" : "Continue to Koed"}
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
