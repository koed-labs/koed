import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Folder,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  Shield,
  ShieldOff,
  Square,
  Settings2,
  PenLine
} from "lucide-react";
import "./visual.css";

import { DEFAULT_AGENT_LOOK, type AgentLook } from "./pixelkin/agent-kin.js";
import { Pixelkin } from "./pixelkin/Pixelkin.js";

export { DEFAULT_AGENT_LOOK, type AgentLook } from "./pixelkin/agent-kin.js";
export { AgentLookPicker } from "./pixelkin/AgentLookPicker.js";
export { Pixelkin };

export type V1ModelOption = {
  id: string;
  label: string;
  description?: string;
  efforts: readonly string[];
  defaultEffort?: string;
  disabled?: boolean;
};
export type V1ModelProvider = {
  id: string;
  label: string;
  via?: string;
  models: readonly V1ModelOption[];
};
export type V1ModelSelection = {
  providerId: string;
  modelId: string;
  effort: string;
};
export type ModelPickerProps = {
  providers: readonly V1ModelProvider[];
  selection?: V1ModelSelection | null;
  onChange: (selection: V1ModelSelection) => void;
  look?: AgentLook;
  onOpenSettings?: () => void;
  onOpen?: () => void;
  disabled?: boolean;
  lockedProviderId?: string;
};
const effortName = (effort: string) =>
  ({
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max"
  })[effort] ??
  effort.charAt(0).toUpperCase() + effort.slice(1).replaceAll("-", " ");
export function ModelPicker({
  providers,
  selection,
  onChange,
  look = DEFAULT_AGENT_LOOK,
  onOpenSettings,
  onOpen,
  disabled = false,
  lockedProviderId
}: ModelPickerProps) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<"effort" | "models">("effort");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node))
        setOpen(false);
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const provider = providers.find((p) => p.id === selection?.providerId),
    model = provider?.models.find((m) => m.id === selection?.modelId);
  const efforts = model?.efforts ?? [];
  const effortIndex = selection ? efforts.indexOf(selection.effort) : -1;
  const changeEffort = (index: number) => {
    if (selection && efforts[index])
      onChange({ ...selection, effort: efforts[index] });
  };
  const onSliderKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      changeEffort(Math.max(0, effortIndex - 1));
    }
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      changeEffort(Math.min(efforts.length - 1, effortIndex + 1));
    }
  };
  const pickAt = (clientX: number, element: HTMLDivElement) => {
    const rect = element.getBoundingClientRect();
    changeEffort(
      Math.max(
        0,
        Math.min(
          efforts.length - 1,
          Math.floor(((clientX - rect.left) / rect.width) * efforts.length)
        )
      )
    );
  };
  return (
    <div className="v1-model-picker" ref={root}>
      <button
        type="button"
        className="v1-mode-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
          setView("effort");
        }}
        title={
          model
            ? `Model: ${provider?.via ?? provider?.label} · ${model.label} · ${effortName(selection?.effort ?? "")}`
            : "Connect an AI in Settings"
        }
      >
        {model ? (
          <>
            <span className="v1-model-label">{model.label}</span>
            <span
              className="v1-heat-dot"
              style={{
                background: `var(--v1-heat-${Math.max(1, Math.ceil(((effortIndex + 1) / Math.max(efforts.length, 1)) * 4))})`
              }}
            />
            <span className="v1-effort-label">
              {effortName(selection?.effort ?? "")}
            </span>
          </>
        ) : (
          "No AI"
        )}
        <ChevronDown size={15} />
      </button>
      {open && (
        <div
          className="v1-model-menu"
          role="dialog"
          aria-label={view === "models" ? "Choose model" : "Reasoning"}
        >
          {!model ? (
            <p className="v1-menu-empty">Connect an AI in Settings first.</p>
          ) : view === "models" ? (
            <>
              <div className="v1-model-menu-heading">
                <button
                  type="button"
                  className="v1-icon"
                  aria-label="Back"
                  onClick={() => setView("effort")}
                >
                  <ChevronLeft />
                </button>
                <b>Model</b>
                <span />
              </div>
              {providers
                .filter((p) => !lockedProviderId || p.id === lockedProviderId)
                .map((p) => (
                  <div key={p.id}>
                    <div className="v1-provider-title">
                      {p.label}
                      {p.via ? ` · ${p.via}` : ""}
                    </div>
                    {p.models.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="v1-model-option"
                        role="menuitemradio"
                        aria-checked={
                          selection?.providerId === p.id &&
                          selection.modelId === m.id
                        }
                        disabled={m.disabled}
                        onClick={() => {
                          onChange({
                            providerId: p.id,
                            modelId: m.id,
                            effort: m.efforts.includes(selection?.effort ?? "")
                              ? selection!.effort
                              : m.defaultEffort &&
                                  m.efforts.includes(m.defaultEffort)
                                ? m.defaultEffort
                                : (m.efforts[0] ?? "")
                          });
                          setView("effort");
                        }}
                      >
                        <span>
                          <b>{m.label}</b>
                          <small>{m.description ?? p.label}</small>
                        </span>
                        {selection?.providerId === p.id &&
                          selection.modelId === m.id && <Check size={16} />}
                      </button>
                    ))}
                  </div>
                ))}
              {onOpenSettings && (
                <button
                  type="button"
                  className="v1-model-settings"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                >
                  AI settings
                  <ChevronRight size={16} />
                </button>
              )}
            </>
          ) : (
            <div className="v1-reason-panel">
              <div className="v1-reason-top">
                <Pixelkin look={look} size={22} />
                <div>
                  <b>{effortName(selection?.effort ?? "")}</b>
                  <button type="button" onClick={() => setView("models")}>
                    {provider?.via ?? provider?.label} · {model.label}
                    <ChevronRight size={15} />
                  </button>
                </div>
                <button
                  type="button"
                  className="v1-icon"
                  aria-label="Reset reasoning"
                  onClick={() =>
                    changeEffort(
                      Math.max(0, efforts.indexOf(model.defaultEffort ?? ""))
                    )
                  }
                >
                  ↺
                </button>
              </div>
              <div
                className="v1-reason-bars"
                role="slider"
                tabIndex={0}
                aria-label="Reasoning"
                aria-valuemin={0}
                aria-valuemax={Math.max(0, efforts.length - 1)}
                aria-valuenow={Math.max(0, effortIndex)}
                aria-valuetext={effortName(selection?.effort ?? "")}
                onKeyDown={onSliderKey}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pickAt(e.clientX, e.currentTarget);
                }}
                onPointerMove={(e) => {
                  if (e.buttons) pickAt(e.clientX, e.currentTarget);
                }}
              >
                {efforts.map((effort, index) => (
                  <span
                    key={effort}
                    className={index <= effortIndex ? "on" : ""}
                    title={effortName(effort)}
                    style={
                      {
                        "--v1-bar-color": `var(--v1-heat-${Math.max(1, Math.ceil(((index + 1) / efforts.length) * 4))})`
                      } as CSSProperties
                    }
                  >
                    {Array.from({ length: index + 1 }, (_, i) => (
                      <i key={i} />
                    ))}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type V1HistoryItem = {
  id: string;
  title: string;
  active?: boolean;
  onSelect: () => void;
  onContextMenu?: () => void;
  action?: ReactNode;
};
export type V1HistoryGroup = {
  id: string;
  label: string;
  items: readonly V1HistoryItem[];
  action?: ReactNode;
};
export type V1ShellProps = {
  children: ReactNode;
  title?: ReactNode;
  topActions?: ReactNode;
  groups?: readonly V1HistoryGroup[];
  accountLabel?: string;
  accountSubLabel?: string;
  onAccount?: () => void;
  onNewConversation?: () => void;
  onNewProject?: () => void;
  onSearch?: () => void;
  onHome?: () => void;
  railWidth?: number;
  onRailWidthChange?: (width: number) => void;
  defaultRailExpanded?: boolean;
  railFooter?: ReactNode;
  className?: string;
};
export function V1Shell({
  children,
  title,
  topActions,
  groups = [],
  accountLabel,
  onAccount,
  accountSubLabel,
  onNewConversation,
  onNewProject,
  onSearch,
  onHome,
  railWidth,
  onRailWidthChange,
  defaultRailExpanded = false,
  railFooter,
  className = ""
}: V1ShellProps) {
  const [wide, setWide] = useState(defaultRailExpanded),
    [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const width = Math.max(200, Math.min(440, railWidth ?? 268));
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!wide) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons && wide)
      onRailWidthChange?.(
        Math.max(200, Math.min(440, Math.round(event.clientX)))
      );
  };
  const filtered = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        item.title.toLowerCase().includes(query.toLowerCase())
      )
    }))
    .filter(
      (group) =>
        !query ||
        group.items.length ||
        group.label.toLowerCase().includes(query.toLowerCase())
    );
  return (
    <div
      className={`v1-app ${wide ? "v1-wide" : ""} ${drawer ? "v1-drawer" : ""} ${className}`}
      style={{ "--v1-rail-width": `${width}px` } as CSSProperties}
    >
      {drawer && (
        <button
          className="v1-drawer-scrim"
          aria-label="Close navigation"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className="v1-rail" ref={railRef} aria-label="Navigation">
        <div className="v1-rail-top">
          <button
            type="button"
            className="v1-brand"
            onClick={onHome ?? onNewConversation}
            aria-label="Koed, home"
          >
            <span className="v1-logo">
              <i />
              <i />
              <i />
              <i />
            </span>
            <b className="v1-wide-only">Koed</b>
          </button>
          <button
            type="button"
            className="v1-icon v1-collapse v1-wide-only"
            aria-label="Collapse sidebar"
            onClick={() => setWide(false)}
          >
            <PanelLeftClose />
          </button>
        </div>
        <nav className="v1-rail-nav" aria-label="Main">
          {searchOpen && wide ? (
            <div className="v1-find">
              <Search size={16} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearchOpen(false);
                    setQuery("");
                  }
                }}
                placeholder="Search chats"
                aria-label="Search chats"
              />
              <button
                type="button"
                className="v1-icon"
                onClick={() => {
                  setSearchOpen(false);
                  setQuery("");
                }}
                aria-label="Close search"
              >
                ×
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="v1-icon"
                title="New chat"
                aria-label="New chat"
                onClick={onNewConversation}
              >
                <PenLine />
              </button>
              <button
                type="button"
                className="v1-icon"
                title="Search chats"
                aria-label="Search chats"
                onClick={() => {
                  setWide(true);
                  setSearchOpen(true);
                  onSearch?.();
                }}
              >
                <Search />
              </button>
              <button
                type="button"
                className="v1-icon"
                title="New project"
                aria-label="New project"
                onClick={onNewProject}
              >
                <Plus />
              </button>
            </>
          )}
        </nav>
        <div className="v1-history v1-wide-only">
          {filtered.map((group) => (
            <section key={group.id}>
              <div className="v1-history-group">
                <span>{group.label}</span>
                {group.action}
              </div>
              {group.items.length ? (
                group.items.map((item) => (
                  <div
                    className={`v1-history-item ${item.active ? "v1-active" : ""}`}
                    key={item.id}
                  >
                    <button
                      type="button"
                      onContextMenu={
                        item.onContextMenu
                          ? (event) => {
                              event.preventDefault();
                              item.onContextMenu?.();
                            }
                          : undefined
                      }
                      onClick={() => {
                        item.onSelect();
                        setDrawer(false);
                      }}
                      title={item.title}
                    >
                      {item.title}
                    </button>
                    {item.action}
                  </div>
                ))
              ) : (
                <p className="v1-history-empty">No chats yet.</p>
              )}
            </section>
          ))}
        </div>
        <div className="v1-rail-footer">
          {railFooter}
          {onAccount && (
            <button
              type="button"
              className="v1-account"
              onClick={onAccount}
              aria-label={
                accountLabel ? `${accountLabel}: settings` : "Settings"
              }
            >
              <span className="v1-avatar">
                {accountLabel?.charAt(0).toUpperCase() ?? (
                  <Settings2 size={17} />
                )}
              </span>
              <span className="v1-account-label v1-wide-only">
                {accountLabel ?? "Settings"}
                {accountSubLabel && <small>{accountSubLabel}</small>}
              </span>
            </button>
          )}
        </div>
      </aside>
      <div
        className="v1-rail-resize"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onPointerDown={startResize}
        onPointerMove={resize}
        onDoubleClick={() => onRailWidthChange?.(268)}
      />
      <main className="v1-main">
        <header className="v1-top">
          <button
            type="button"
            className="v1-icon v1-top-menu"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
          >
            <Menu />
          </button>
          {!wide && (
            <button
              type="button"
              className="v1-icon v1-top-expand"
              aria-label="Expand sidebar"
              onClick={() => setWide(true)}
            >
              <PanelLeftOpen />
            </button>
          )}
          <div className="v1-top-title">{title}</div>
          {topActions}
        </header>
        {children}
      </main>
    </div>
  );
}
export type V1ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  actionDisabled?: boolean;
  inputLabel?: string;
  label?: string;
  placeholder?: string;
  projectLabel?: string;
  onProject?: () => void;
  permissionLabel?: string;
  onPermission?: () => void;
  modelPicker?: ReactNode;
  className?: string;
};
export function V1Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  disabled = false,
  actionDisabled = false,
  inputLabel,
  label = "Message",
  placeholder = "What do you want to get done?",
  projectLabel = "No project",
  onProject,
  permissionLabel = "Ask first",
  onPermission,
  modelPicker,
  className = ""
}: V1ComposerProps) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (textRef.current) {
      textRef.current.style.height = "auto";
      textRef.current.style.height = `${Math.min(220, textRef.current.scrollHeight)}px`;
    }
  }, [value]);
  const submit = () => {
    if (!busy && value.trim() && !disabled && !actionDisabled) onSend();
  };
  return (
    <form
      className={`v1-composer ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label={inputLabel ?? label}
        disabled={disabled}
        rows={1}
      />
      <div className="v1-composer-row">
        {modelPicker}
        {onPermission && (
          <button
            type="button"
            className="v1-composer-option"
            onClick={onPermission}
          >
            {permissionLabel === "Full access" ? (
              <ShieldOff size={15} />
            ) : (
              <Shield size={15} />
            )}
            <span>{permissionLabel}</span>
            <ChevronDown size={15} />
          </button>
        )}
        {onProject && (
          <button
            type="button"
            className="v1-composer-option"
            onClick={onProject}
          >
            <Folder size={15} />
            <span>{projectLabel}</span>
            <ChevronDown size={15} />
          </button>
        )}
        <span className="v1-composer-spacer" />
        <button
          type={busy ? "button" : "submit"}
          onClick={busy ? onStop : undefined}
          className="v1-send"
          aria-label={busy ? "Stop" : "Send"}
          title={busy ? "Stop" : "Send"}
          disabled={
            busy ? !onStop : disabled || actionDisabled || !value.trim()
          }
        >
          {busy ? <Square size={16} fill="currentColor" /> : <Send size={18} />}
        </button>
      </div>
    </form>
  );
}
export function V1EmptyHero({
  look = DEFAULT_AGENT_LOOK,
  agentName = "Koed",
  subtitle,
  composer,
  children
}: {
  look?: AgentLook;
  agentName?: string;
  subtitle?: ReactNode;
  composer: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="v1-hero">
      <div className="v1-hero-mark">
        <Pixelkin look={look} size={64} />
        <h1>{agentName}</h1>
      </div>
      {subtitle && <p className="v1-hero-subtitle">{subtitle}</p>}
      <div className="v1-hero-composer">{composer}</div>
      {children}
    </section>
  );
}
export function V1ThreadLayout({
  children,
  composer
}: {
  children: ReactNode;
  composer: ReactNode;
}) {
  return (
    <>
      <div className="v1-scroll">
        <div className="v1-thread">{children}</div>
      </div>
      <div className="v1-dock">{composer}</div>
    </>
  );
}
export function V1Message({
  role,
  children,
  actions,
  meta,
  working = false,
  look = DEFAULT_AGENT_LOOK
}: {
  role: "user" | "assistant";
  children: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  working?: boolean;
  look?: AgentLook;
}) {
  return role === "user" ? (
    <article className="v1-message v1-user">
      <div className="v1-bubble">{children}</div>
      {actions && <div className="v1-message-actions">{actions}</div>}
    </article>
  ) : (
    <article className="v1-message v1-assistant">
      {working ? (
        <div className="v1-thinking">
          <Pixelkin look={look} size={26} />
          <span>{children}</span>
        </div>
      ) : (
        <div className="v1-answer">{children}</div>
      )}
      {(actions || meta) && (
        <div className="v1-message-actions">
          {actions}
          {meta && <span className="v1-message-meta">{meta}</span>}
        </div>
      )}
    </article>
  );
}
