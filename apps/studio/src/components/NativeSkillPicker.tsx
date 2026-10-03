"use client";

import {
  useEffect,
  useState,
  useMemo,
  type KeyboardEvent,
  type RefObject
} from "react";
export type NativeSkillKeyboardHandler = (
  event: KeyboardEvent<HTMLTextAreaElement>
) => boolean;
import {
  clientLabel,
  discoverClientResources,
  loadClientResourceTargets,
  type ClientResourceCatalog
} from "@/lib/client-resources-client";

export type NativeSkillScope = Readonly<{
  projectId: string | null;
  hostedInstanceId?: string;
  instanceId?: string;
  provider?: string;
}>;
export type NativeSkill = ClientResourceCatalog["resources"][number];

/** Discovery is read-only and is scoped to the selected native Client and Project. */
export function NativeSkillPicker({
  scope,
  query,
  onSelect,
  onDismiss,
  keyboardRef
}: {
  scope: NativeSkillScope;
  query: string;
  onSelect: (skill: NativeSkill) => void;
  onDismiss: () => void;
  keyboardRef: RefObject<NativeSkillKeyboardHandler | null>;
}) {
  const [result, setResult] = useState<{
    key: string;
    catalog?: ClientResourceCatalog;
    error?: string;
  } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const key = JSON.stringify(scope);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const targets = await loadClientResourceTargets(controller.signal);
      const matches = targets.filter((target) =>
        scope.hostedInstanceId
          ? target.hostedInstanceId === scope.hostedInstanceId
          : target.provider === scope.provider &&
            (!scope.instanceId || target.instanceId === scope.instanceId)
      );
      if (matches.length !== 1)
        throw new Error(
          matches.length
            ? "Choose a specific AI Client and computer before selecting a Skill."
            : "Choose an available AI Client to see its Skills."
        );
      const target = matches[0];
      if (!target.enabled)
        throw new Error(
          "This AI Client is disabled. Enable it in its settings before choosing a Skill."
        );
      if (target.authenticationState === "unauthenticated")
        throw new Error(
          "Sign in through the original AI Client before choosing a Skill."
        );
      const catalog = await discoverClientResources(
        {
          hostedInstanceId: target.hostedInstanceId,
          projectId: scope.projectId
        },
        controller.signal
      );
      if (
        catalog.provider !== target.provider ||
        catalog.aiClientInstanceId !== target.instanceId
      )
        throw new Error(
          "The AI Client changed. Refresh its Skills before continuing."
        );
      if (!controller.signal.aborted) setResult({ key, catalog });
    })().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setResult({
          key,
          error:
            error instanceof Error ? error.message : "Skills are unavailable."
        });
    });
    return () => controller.abort();
  }, [
    key,
    scope.hostedInstanceId,
    scope.instanceId,
    scope.projectId,
    scope.provider
  ]);
  const current = result?.key === key ? result : null;
  const skills = useMemo(
    () =>
      current?.catalog?.resources.filter(
        (resource) =>
          resource.kind === "skill" &&
          resource.status === "ready" &&
          resource.invocation === "native_skill" &&
          `${resource.name} ${resource.description ?? ""}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
      ) ?? [],
    [current?.catalog, query]
  );
  const activeIndex = skills.length ? highlightedIndex % skills.length : 0;
  useEffect(() => {
    const handler: NativeSkillKeyboardHandler = (event) => {
      if (event.key === "Escape") {
        onDismiss();
        return true;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (skills.length)
          setHighlightedIndex(
            (index) =>
              (index + (event.key === "ArrowDown" ? 1 : -1) + skills.length) %
              skills.length
          );
        return true;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        if (skills[activeIndex]) onSelect(skills[activeIndex]);
        return true;
      }
      return false;
    };
    keyboardRef.current = handler;
    return () => {
      if (keyboardRef.current === handler) keyboardRef.current = null;
    };
  }, [activeIndex, keyboardRef, onDismiss, onSelect, skills]);
  return (
    <div
      className="absolute bottom-full left-2 z-40 mb-2 max-h-64 w-[min(24rem,calc(100cqw-1rem))] overflow-y-auto rounded-lg border border-border-strong bg-surface p-2 shadow-xl"
      role="dialog"
      aria-label="AI Client Skills"
    >
      <div className="mb-2 flex items-center justify-between px-2 text-xs text-subtle">
        <span>
          {clientLabel(
            current?.catalog?.provider ?? scope.provider ?? "AI Client"
          )}{" "}
          Skills
        </span>
        <button type="button" onClick={onDismiss} aria-label="Close Skills">
          Close
        </button>
      </div>
      {current?.error ? (
        <p className="px-2 py-3 text-sm text-foreground-secondary">
          {current.error}
        </p>
      ) : !current?.catalog ? (
        <p className="px-2 py-3 text-sm text-subtle">
          Reading configured Skills…
        </p>
      ) : !skills.length ? (
        <p className="px-2 py-3 text-sm text-subtle">
          No matching available Skills in this Client and Project.
        </p>
      ) : (
        skills.map((skill, index) => (
          <button
            key={skill.resourceId}
            role="option"
            aria-selected={index === activeIndex}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(skill)}
            className={`block w-full rounded px-2 py-2 text-left hover:bg-surface-hover ${index === activeIndex ? "bg-surface-hover" : ""}`}
          >
            <span className="block text-sm text-foreground">/{skill.name}</span>
            {skill.description && (
              <span className="block line-clamp-2 text-xs text-subtle">
                {skill.description}
              </span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
