"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentDefinition } from "@/lib/collab";
import {
  listPersonalAgentRoleTemplates,
  rankRoleTemplates,
  type PersonalAgentRoleTemplate
} from "@/lib/personal-agent-role-templates-client";
import {
  canSubmitAgentIdentity,
  createAgentIdentityDraftStore,
  effortsForModel,
  generatedSoul,
  initialAgentIdentityEditorValues,
  modelOptions,
  preferredEffortForModel,
  type AgentIdentityDraftScope,
  type AgentIdentityEditorInitialValues,
  type AgentIdentityEditorValues,
  type AgentModelCapability
} from "@/lib/agentIdentityEditor";
import { PixelkinLab, type PixelkinLabHandle } from "./PixelkinLab";
import { useWorkspace } from "./WorkspaceProvider";

export type AgentIdentitySubmitResult = Readonly<{ definitionId: string }>;

export type CreateAgentModalProps = Readonly<{
  onClose: () => void;
  onCreated: (definitionId: string) => void;
  editDefinition?: AgentDefinition;
  initialValues?: AgentIdentityEditorInitialValues;
  draftIdentity?: Readonly<{
    scope: AgentIdentityDraftScope;
    target: string;
  }>;
  capabilities?: readonly AgentModelCapability[];
  onSubmit?: (
    values: AgentIdentityEditorValues
  ) => AgentIdentitySubmitResult | Promise<AgentIdentitySubmitResult>;
}>;

export function CreateAgentModal(props: CreateAgentModalProps) {
  if (props.onSubmit) {
    return (
      <AgentIdentityEditor
        {...props}
        legacyMode={false}
        onSubmit={props.onSubmit}
      />
    );
  }
  return <LegacyCreateAgentModal {...props} />;
}

function LegacyCreateAgentModal(props: CreateAgentModalProps) {
  const { createAgentDefinition, updateAgentDefinition } = useWorkspace();
  const handleSubmit: NonNullable<CreateAgentModalProps["onSubmit"]> = (
    values
  ) => {
    const definition = props.editDefinition
      ? updateAgentDefinition(props.editDefinition.id, {
          name: values.name,
          role: values.role,
          avatar: values.avatar ?? props.editDefinition.avatar
        })
      : createAgentDefinition({
          name: values.name,
          role: values.role,
          avatar: values.avatar
        });
    return { definitionId: definition.id };
  };

  return <AgentIdentityEditor {...props} onSubmit={handleSubmit} legacyMode />;
}

type AgentIdentityEditorProps = Omit<CreateAgentModalProps, "onSubmit"> & {
  legacyMode: boolean;
  onSubmit: NonNullable<CreateAgentModalProps["onSubmit"]>;
};

function AgentIdentityEditor({
  onClose,
  onCreated,
  editDefinition,
  initialValues,
  draftIdentity,
  capabilities = [],
  onSubmit,
  legacyMode
}: AgentIdentityEditorProps) {
  const isEditing = Boolean(editDefinition);
  const labRef = useRef<PixelkinLabHandle>(null);
  const draftOwnerId = draftIdentity?.scope.ownerId;
  const draftBackendId = draftIdentity?.scope.backendId;
  const draftTarget = draftIdentity?.target;
  const draftStore = useMemo(
    () =>
      draftOwnerId && draftBackendId && draftTarget
        ? createAgentIdentityDraftStore({
            scope: { ownerId: draftOwnerId, backendId: draftBackendId },
            target: draftTarget
          })
        : null,
    [draftBackendId, draftOwnerId, draftTarget]
  );
  const initial = useMemo(
    () =>
      initialAgentIdentityEditorValues({
        definition: editDefinition,
        initialValues
      }),
    [editDefinition, initialValues]
  );
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role);
  const [soul, setSoul] = useState(initial.soul);
  const [draftAvatar, setDraftAvatar] = useState(initial.avatar);
  const [soulEdited, setSoulEdited] = useState(
    initialValues?.soul !== undefined || editDefinition?.identity !== undefined
  );
  const [preferredModel, setPreferredModel] = useState(initial.preferredModel);
  const [preferredEffort, setPreferredEffort] = useState(
    initial.preferredEffort
  );
  const [sourceTemplateId, setSourceTemplateId] = useState(
    initial.sourceTemplateId
  );
  const [sourceTemplateVersion, setSourceTemplateVersion] = useState(
    initial.sourceTemplateVersion
  );
  const [roleTemplates, setRoleTemplates] = useState<
    PersonalAgentRoleTemplate[]
  >([]);
  const [templateLoading, setTemplateLoading] = useState(!legacyMode);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState(false);
  const [replaceTemplateConfirmOpen, setReplaceTemplateConfirmOpen] =
    useState(false);
  const [saving, setSaving] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [draftHydrating, setDraftHydrating] = useState(Boolean(draftStore));
  const [draftStorageError, setDraftStorageError] = useState<string | null>(
    null
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const userEditedDraftRef = useRef(false);

  const markDraftDirty = () => {
    userEditedDraftRef.current = true;
    setDraftDirty(true);
  };

  useEffect(() => {
    if (!draftStore || legacyMode) return;
    let active = true;
    void draftStore
      .hydrate()
      .then((values) => {
        if (!active) return;
        if (values && !userEditedDraftRef.current) {
          setName(values.name);
          setRole(values.role);
          setSoul(values.soul);
          setDraftAvatar(values.avatar);
          setSoulEdited(true);
          setPreferredModel(values.preferredModel);
          setPreferredEffort(values.preferredEffort);
          setSourceTemplateId(values.sourceTemplateId);
          setSourceTemplateVersion(values.sourceTemplateVersion);
        }
        if (values) setDraftDirty(true);
      })
      .catch(() => {
        if (active) {
          setDraftStorageError("This device could not read the local draft.");
        }
      })
      .finally(() => {
        if (active) setDraftHydrating(false);
      });
    return () => {
      active = false;
    };
  }, [draftStore, legacyMode]);

  useEffect(() => {
    if (!draftStore || !draftDirty || draftHydrating || saving || legacyMode)
      return;
    const persist = () => {
      void draftStore
        .write({
          name,
          role,
          soul,
          avatar: labRef.current?.capture() ?? draftAvatar,
          preferredModel,
          preferredEffort,
          sourceTemplateId,
          sourceTemplateVersion
        })
        .then(() => setDraftStorageError(null))
        .catch(() =>
          setDraftStorageError("This device could not save the local draft.")
        );
    };
    persist();
    const interval = window.setInterval(persist, 1000);
    return () => window.clearInterval(interval);
  }, [
    draftDirty,
    draftAvatar,
    draftHydrating,
    draftStore,
    legacyMode,
    name,
    preferredEffort,
    preferredModel,
    role,
    soul,
    sourceTemplateId,
    sourceTemplateVersion,
    saving
  ]);

  const modelCapabilities = [...capabilities];
  const modelOptionsForEditor = modelOptions(modelCapabilities, preferredModel);
  const effortOptions = effortsForModel(modelCapabilities, preferredModel);
  const effectiveSoul = soulEdited ? soul : generatedSoul(name, role);
  const selectedTemplate = roleTemplates.find(
    (template) => template.id === selectedTemplateId
  );
  const selectedTemplateSoul = selectedTemplate
    ? name.trim()
      ? selectedTemplate.soulInstructions.replace(
          /^You are /m,
          `You are ${name.trim()}, `
        )
      : selectedTemplate.soulInstructions
    : "";
  const roleSuggestions = rankRoleTemplates(role, roleTemplates).slice(0, 3);
  useEffect(() => {
    if (legacyMode) return;
    const controller = new AbortController();
    listPersonalAgentRoleTemplates(controller.signal)
      .then((templates) => {
        if (controller.signal.aborted) return;
        setRoleTemplates(templates);
        setTemplateLoading(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setTemplateError(
          error instanceof Error
            ? error.message
            : "Role templates are unavailable."
        );
        setTemplateLoading(false);
      });
    return () => controller.abort();
  }, [legacyMode]);

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (replaceTemplateConfirmOpen) {
        setReplaceTemplateConfirmOpen(false);
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, replaceTemplateConfirmOpen]);

  const handleModelChange = (model: string) => {
    markDraftDirty();
    setPreferredModel(model || null);
    setPreferredEffort(
      preferredEffortForModel(modelCapabilities, model || null, preferredEffort)
    );
  };

  const submit = async () => {
    if (
      saving ||
      draftHydrating ||
      !canSubmitAgentIdentity({ name, role, soul: effectiveSoul })
    ) {
      return;
    }
    const avatar = labRef.current?.capture() ?? draftAvatar;
    const values: AgentIdentityEditorValues = {
      name: name.trim(),
      role: role.trim(),
      soul: effectiveSoul.trim(),
      avatar,
      preferredModel,
      preferredEffort,
      sourceTemplateId,
      sourceTemplateVersion
    };
    setSaving(true);
    setSubmitError(null);
    try {
      const result = await onSubmit(values);
      if (draftStore) {
        try {
          await draftStore.clear();
        } catch {
          setDraftStorageError(
            "The Agent was saved, but this device could not clear its local draft."
          );
        }
      }
      onCreated(result.definitionId);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Unable to save this agent."
      );
    } finally {
      setSaving(false);
    }
  };

  const applyTemplate = () => {
    if (!selectedTemplate) return;
    if (soulEdited) {
      setReplaceTemplateConfirmOpen(true);
      return;
    }
    confirmApplyTemplate();
  };

  const confirmApplyTemplate = () => {
    if (!selectedTemplate) return;
    setRole(selectedTemplate.role);
    setSoul(selectedTemplateSoul);
    setSoulEdited(true);
    setSourceTemplateId(selectedTemplate.id);
    setSourceTemplateVersion(selectedTemplate.version);
    setTemplatePreviewOpen(true);
    setReplaceTemplateConfirmOpen(false);
  };

  const handleRoleChange = (value: string) => {
    setRole(value);
    setSelectedTemplateId("");
    setTemplatePreviewOpen(false);
  };

  const selectRoleSuggestion = (template: PersonalAgentRoleTemplate) => {
    setRole(template.role);
    setSelectedTemplateId(template.id);
    setTemplatePreviewOpen(true);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-editor-title"
        className="flex max-h-[calc(100vh-2rem)] w-[920px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <h2
            id="agent-editor-title"
            className="text-base font-semibold text-foreground"
          >
            {isEditing
              ? `Edit ${editDefinition?.name || "agent"}`
              : "Create agent"}
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-surface-hover hover:text-foreground-secondary"
            onClick={close}
            disabled={saving}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-5 pb-5 md:grid-cols-[240px_1fr]">
          <PixelkinLab
            key={JSON.stringify(draftAvatar?.spec ?? null)}
            ref={labRef}
            initialSpec={draftAvatar?.spec}
            onChange={markDraftDirty}
          />
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Name</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => {
                  markDraftDirty();
                  setName(event.target.value);
                }}
                placeholder="Bø, Avery…"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Role</span>
              <input
                value={role}
                onChange={(event) => {
                  markDraftDirty();
                  handleRoleChange(event.target.value);
                }}
                placeholder="Project manager, backend developer…"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </label>
            {!legacyMode && (
              <>
                {roleSuggestions.length > 0 && (
                  <div
                    className="flex flex-wrap items-center gap-2 text-[11px]"
                    aria-label="Suggested roles"
                  >
                    <span className="text-subtle">Suggestions</span>
                    {roleSuggestions.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        onClick={() => {
                          markDraftDirty();
                          selectRoleSuggestion(template);
                        }}
                        className="text-foreground-secondary underline underline-offset-2"
                      >
                        {template.title}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            {!legacyMode && (
              <div className="space-y-2">
                {templateLoading && (
                  <p role="status" className="text-[11px] text-subtle">
                    Loading role templates…
                  </p>
                )}
                {templateError && (
                  <p role="status" className="text-[11px] text-subtle">
                    {templateError}
                  </p>
                )}
                {selectedTemplate && (
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="text-xs text-foreground-secondary underline underline-offset-2"
                      aria-expanded={templatePreviewOpen}
                      onClick={() => setTemplatePreviewOpen((open) => !open)}
                    >
                      {templatePreviewOpen ? "Hide preview" : "Preview"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        markDraftDirty();
                        applyTemplate();
                      }}
                      className="rounded-md border border-border px-2 py-1 text-xs text-foreground-secondary hover:bg-surface-hover"
                    >
                      Use template
                    </button>
                    <span className="text-[11px] text-subtle">
                      v{selectedTemplate.version}
                    </span>
                  </div>
                )}
                {templatePreviewOpen && selectedTemplate && (
                  <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-[11px] leading-relaxed text-muted">
                    {selectedTemplateSoul}
                  </pre>
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-sm text-muted">
                  Preferred model
                </span>
                <select
                  value={preferredModel ?? ""}
                  onChange={(event) => handleModelChange(event.target.value)}
                  disabled={legacyMode}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">No default</option>
                  {modelOptionsForEditor.map((option) => (
                    <option
                      key={option.id}
                      value={option.id}
                      disabled={!option.available}
                    >
                      {option.label}
                      {!option.available ? " (unavailable)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm text-muted">
                  Preferred effort
                </span>
                <select
                  value={preferredEffort ?? ""}
                  onChange={(event) => {
                    markDraftDirty();
                    setPreferredEffort(event.target.value || null);
                  }}
                  disabled={legacyMode}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">No default</option>
                  {preferredEffort &&
                    !effortOptions.includes(preferredEffort) && (
                      <option value={preferredEffort} disabled>
                        {preferredEffort} (unavailable)
                      </option>
                    )}
                  {effortOptions.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {legacyMode && (
              <p className="text-[11px] leading-relaxed text-warning">
                Preview persistence is limited to the existing workspace fields.
                Soul, model, and effort are read-only until a connected save
                handler is provided.
              </p>
            )}
            {!legacyMode && draftDirty && (
              <p
                role="status"
                className="text-[11px] leading-relaxed text-warning"
              >
                {draftStorageError
                  ? "Not saved to your account. Device recovery is unavailable; keep this window open until you can save."
                  : "Not saved to your account. This draft is stored on this device."}{" "}
                Select {isEditing ? "Save changes" : "Create agent"} when you
                are ready.
              </p>
            )}
            {draftHydrating && (
              <p
                role="status"
                className="text-[11px] leading-relaxed text-subtle"
              >
                Checking this device for a saved draft…
              </p>
            )}
            {!legacyMode && !draftIdentity && (
              <p
                role="status"
                className="text-[11px] leading-relaxed text-warning"
              >
                Device draft recovery is unavailable until your account and
                backend are verified.
              </p>
            )}
            {draftStorageError && (
              <p
                role="alert"
                className="text-[11px] leading-relaxed text-danger"
              >
                {draftStorageError} Keep this window open until you can save.
              </p>
            )}
            {submitError && (
              <p
                role="alert"
                className="text-[11px] leading-relaxed text-danger"
              >
                {submitError}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end border-t border-border bg-background/40 px-5 py-3">
          <button
            type="button"
            disabled={
              saving ||
              draftHydrating ||
              !name.trim() ||
              !role.trim() ||
              !effectiveSoul.trim()
            }
            className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            onClick={submit}
          >
            {saving ? "Saving…" : isEditing ? "Save changes" : "Create agent"}
          </button>
        </div>
      </div>
      {replaceTemplateConfirmOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm no-drag"
          onClick={(event) => {
            event.stopPropagation();
            setReplaceTemplateConfirmOpen(false);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="replace-template-title"
            aria-describedby="replace-template-description"
            className="w-[400px] max-w-[calc(100vw-2rem)] rounded-2xl border border-border bg-surface p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2
              id="replace-template-title"
              className="text-base font-semibold text-foreground"
            >
              Replace soul.md?
            </h2>
            <p
              id="replace-template-description"
              className="mt-2 text-sm text-muted"
            >
              This replaces the current soul.md with the selected role template.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                className="rounded-lg bg-surface-hover px-3.5 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-active"
                onClick={() => setReplaceTemplateConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-chip px-3.5 py-2 text-sm font-medium text-chip-foreground hover:bg-white"
                onClick={confirmApplyTemplate}
              >
                Replace template
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
