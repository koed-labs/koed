"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AgentDefinition } from "@/lib/collab";
import {
  canSubmitAgentIdentity,
  initialAgentIdentityEditorValues,
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
  /** Legacy props are accepted during integration, but the editor ignores them. */
  draftIdentity?: Readonly<{
    scope: Readonly<{ ownerId: string; backendId: string }>;
    target: string;
  }>;
  capabilities?: readonly AgentModelCapability[];
  onSubmit?: (
    values: AgentIdentityEditorValues
  ) => AgentIdentitySubmitResult | Promise<AgentIdentitySubmitResult>;
}>;

export function CreateAgentModal(props: CreateAgentModalProps) {
  if (props.onSubmit)
    return <AgentIdentityEditor {...props} onSubmit={props.onSubmit} />;
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

  return (
    <AgentIdentityEditor {...props} onSubmit={props.onSubmit ?? handleSubmit} />
  );
}

function AgentIdentityEditor({
  onClose,
  onCreated,
  editDefinition,
  initialValues,
  onSubmit
}: CreateAgentModalProps & {
  onSubmit: NonNullable<CreateAgentModalProps["onSubmit"]>;
}) {
  const isEditing = Boolean(editDefinition);
  const labRef = useRef<PixelkinLabHandle>(null);
  const initial = initialAgentIdentityEditorValues({
    definition: editDefinition,
    initialValues
  });
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role);
  const [avatar, setAvatar] = useState(initial.avatar);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  const submit = async () => {
    if (saving || !canSubmitAgentIdentity({ name })) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const result = await onSubmit({
        name: name.trim(),
        role: role.trim(),
        avatar: labRef.current?.capture() ?? avatar
      });
      onCreated(result.definitionId);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Unable to save this agent."
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/60 p-2 backdrop-blur-sm no-drag sm:p-4"
      onClick={close}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-editor-title"
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl sm:max-h-[calc(100dvh-2rem)]"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
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
        <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-4 pb-5 sm:px-5 md:grid-cols-[240px_minmax(0,1fr)]">
          <PixelkinLab
            key={JSON.stringify(initial.avatar?.spec ?? null)}
            ref={labRef}
            initialSpec={initial.avatar?.spec}
            onChange={() => {
              setAvatar(labRef.current?.capture() ?? avatar);
            }}
          />
          <div className="space-y-4">
            <label className="block">
              <span className="mb-2 block text-sm text-muted">Name</span>
              <input
                autoFocus
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Bø, Avery…"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-sm text-muted">
                Job title <span className="text-subtle">(optional)</span>
              </span>
              <input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="Project manager, backend developer…"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-border-strong"
              />
            </label>
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
        <div className="flex justify-end gap-2 border-t border-border bg-background/40 px-5 py-3">
          <button
            type="button"
            className="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium text-foreground-secondary hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-40"
            onClick={close}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded-lg bg-chip px-4 py-2 text-sm font-medium text-chip-foreground hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : isEditing ? "Save changes" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}
