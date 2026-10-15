import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject
} from "react";

export type NativeSkillPickerScope = Readonly<{
  projectId: string | null;
  hostedInstanceId?: string;
  instanceId?: string;
  provider?: string;
}>;

/** Minimal structural view of a shared native resource, without a package dependency. */
export type NativeSkillPickerResource = Readonly<{
  resourceId: string;
  kind: string;
  name: string;
  description?: string;
  invocation?: string | null;
  availability?: string;
  executionSupport?: string;
}>;

export type NativeSkillPickerCatalog<TSkill extends NativeSkillPickerResource> =
  Readonly<{
    expiresAt: string;
    resources: readonly TSkill[];
  }>;

export type NativeSkillKeyboardHandler = (
  event: KeyboardEvent<HTMLTextAreaElement>
) => boolean;

export const nativeSkillIsSelectable = (
  resource: NativeSkillPickerResource
): boolean =>
  resource.kind === "skill" &&
  resource.invocation === "native_skill" &&
  resource.availability === "available" &&
  resource.executionSupport === "koed_managed";

const catalogHasExpired = (expiresAt: string): boolean =>
  Date.parse(expiresAt) <= Date.now();

const MAX_DISCOVERY_ATTEMPTS = 3;

type NativeSkillPickerCoreProps<TSkill extends NativeSkillPickerResource> = {
  scope: NativeSkillPickerScope;
  query: string;
  title: string;
  loadCatalog: (
    scope: NativeSkillPickerScope,
    signal: AbortSignal
  ) => Promise<NativeSkillPickerCatalog<TSkill>>;
  onSelect: (skill: TSkill, catalogExpiresAt: string) => void;
  onDismiss: () => void;
  keyboardRef: RefObject<NativeSkillKeyboardHandler | null>;
  formatError?: (cause: unknown) => string;
  className?: string;
  loadingMessage?: string;
  emptyMessage?: string;
  unverifiedMessage?: string;
};

/** Shared scoped picker surface. The caller owns authentication and catalog validation. */
export function NativeSkillPickerCore<TSkill extends NativeSkillPickerResource>(
  props: NativeSkillPickerCoreProps<TSkill>
) {
  const scopeKey = JSON.stringify(props.scope);
  return (
    <NativeSkillPickerRequest key={scopeKey} scopeKey={scopeKey} {...props} />
  );
}

function NativeSkillPickerRequest<TSkill extends NativeSkillPickerResource>({
  scopeKey,
  scope,
  query,
  title,
  loadCatalog,
  onSelect,
  onDismiss,
  keyboardRef,
  formatError,
  className,
  loadingMessage = "Reading configured Skills…",
  emptyMessage = "No matching available Skills in this Client and Project.",
  unverifiedMessage = "This Client reported matching Skills, but their availability or Koed invocation route is not verified."
}: NativeSkillPickerCoreProps<TSkill> & { scopeKey: string }) {
  const stableScope = useMemo(() => scope, [scopeKey]);
  const [attempt, setAttempt] = useState(0);
  const requestKey = `${scopeKey}:${attempt}`;
  const [result, setResult] = useState<{
    key: string;
    catalog?: NativeSkillPickerCatalog<TSkill>;
    error?: string;
  } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [expiredCatalog, setExpiredCatalog] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(stableScope, controller.signal)
      .then((catalog) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, catalog });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            error: formatError
              ? formatError(cause)
              : cause instanceof Error
                ? cause.message
                : "Skills are unavailable."
          });
      });
    return () => controller.abort();
  }, [formatError, loadCatalog, requestKey, stableScope]);

  const current = result?.key === requestKey ? result : null;
  const expired = Boolean(
    current?.catalog && expiredCatalog === current.catalog.expiresAt
  );
  useEffect(() => {
    if (!current?.catalog) return;
    const expiresAt = current.catalog.expiresAt;
    const delay = Date.parse(expiresAt) - Date.now();
    const timer = setTimeout(
      () => setExpiredCatalog(expiresAt),
      Math.max(0, delay) + 1
    );
    return () => clearTimeout(timer);
  }, [current?.catalog?.expiresAt]);

  const matchingSkills = useMemo(
    () =>
      current?.catalog?.resources.filter(
        (resource) =>
          resource.kind === "skill" &&
          `${resource.name} ${resource.description ?? ""}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
      ) ?? [],
    [current?.catalog, query]
  );
  const skills = useMemo(
    () => matchingSkills.filter(nativeSkillIsSelectable),
    [matchingSkills]
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
        if (
          skills[activeIndex] &&
          current?.catalog &&
          !catalogHasExpired(current.catalog.expiresAt)
        )
          onSelect(skills[activeIndex], current.catalog.expiresAt);
        return true;
      }
      return false;
    };
    keyboardRef.current = handler;
    return () => {
      if (keyboardRef.current === handler) keyboardRef.current = null;
    };
  }, [
    activeIndex,
    current?.catalog,
    expired,
    keyboardRef,
    onDismiss,
    onSelect,
    skills
  ]);

  const retry = () => {
    if (attempt >= MAX_DISCOVERY_ATTEMPTS - 1) return;
    setResult(null);
    setAttempt((currentAttempt) => currentAttempt + 1);
  };
  const retryButton = (label: string) =>
    attempt < MAX_DISCOVERY_ATTEMPTS - 1 ? (
      <button
        type="button"
        className="mt-2 rounded border border-border px-2 py-1 text-xs"
        onClick={retry}
      >
        {label}
      </button>
    ) : null;

  return (
    <div
      className={
        className ??
        "absolute bottom-full left-2 z-40 mb-2 max-h-64 w-[min(24rem,calc(100cqw-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
      }
      role="dialog"
      aria-label={title}
    >
      <div className="mb-2 flex items-center justify-between px-2 text-xs text-muted-foreground">
        <span>{title}</span>
        <button type="button" onClick={onDismiss} aria-label="Close Skills">
          Close
        </button>
      </div>
      {current?.error ? (
        <div className="px-2 py-3 text-sm">
          <p>{current.error}</p>
          {retryButton("Retry resource discovery")}
        </div>
      ) : !current?.catalog ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">
          {loadingMessage}
        </p>
      ) : expired ? (
        <div className="px-2 py-3 text-sm">
          <p>This Skills list expired. Refresh it before selecting a Skill.</p>
          {retryButton("Refresh Skills")}
        </div>
      ) : !skills.length ? (
        <p className="px-2 py-3 text-sm text-muted-foreground">
          {matchingSkills.length ? unverifiedMessage : emptyMessage}
        </p>
      ) : (
        skills.map((skill, index) => (
          <button
            key={skill.resourceId}
            role="option"
            aria-selected={index === activeIndex}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (
                current.catalog &&
                !catalogHasExpired(current.catalog.expiresAt)
              )
                onSelect(skill, current.catalog.expiresAt);
            }}
            className={`block w-full rounded px-2 py-2 text-left hover:bg-accent ${index === activeIndex ? "bg-accent" : ""}`}
          >
            <span className="block text-sm">/{skill.name}</span>
            {skill.description && (
              <span className="block line-clamp-2 text-xs text-muted-foreground">
                {skill.description}
              </span>
            )}
          </button>
        ))
      )}
    </div>
  );
}
