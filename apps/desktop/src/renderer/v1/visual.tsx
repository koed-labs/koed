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

export type AgentLook = {
  shape: "block" | "bean" | "tall" | "wide";
  color:
    | "violet"
    | "blue"
    | "mint"
    | "lime"
    | "sun"
    | "coral"
    | "pink"
    | "slate";
  top: "none" | "antenna" | "sprout" | "ears";
};
export const DEFAULT_AGENT_LOOK: AgentLook = {
  shape: "block",
  color: "violet",
  top: "none"
};
export const PIXELKIN_PALETTE: Record<
  AgentLook["color"],
  readonly [string, string, string, string]
> = {
  violet: ["#c4bdff", "#9d93fb", "#7467e6", "#241a6b"],
  blue: ["#a9d6ff", "#62aef5", "#3c84d6", "#123766"],
  mint: ["#b1f3d4", "#5fd6a0", "#33a674", "#124a32"],
  lime: ["#e6f8a6", "#bde05a", "#8db52f", "#36500f"],
  sun: ["#ffe59a", "#ffc53f", "#e49b10", "#5f3c02"],
  coral: ["#ffbcae", "#ff8268", "#e0563e", "#62200f"],
  pink: ["#ffbdd8", "#f476ab", "#d24884", "#5c1435"],
  slate: ["#dfe2ea", "#aeb3c2", "#7d8397", "#262a36"]
};
const shapes: AgentLook["shape"][] = ["block", "bean", "tall", "wide"];
const tops: AgentLook["top"][] = ["none", "antenna", "sprout", "ears"];
export const randomAgentLook = (): AgentLook => ({
  shape: shapes[Math.floor(Math.random() * shapes.length)]!,
  color: (Object.keys(PIXELKIN_PALETTE) as AgentLook["color"][])[
    Math.floor(Math.random() * Object.keys(PIXELKIN_PALETTE).length)
  ]!,
  top: tops[Math.floor(Math.random() * tops.length)]!
});
const topNames: Record<AgentLook["top"], string> = {
  none: "Nothing on top",
  antenna: "Antenna",
  sprout: "Sprout",
  ears: "Ears"
};
const roundRect = (
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number
) => {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const dx = Math.max(x0 + r - px, 0, px - (x1 - r));
  const dy = Math.max(y0 + r - py, 0, py - (y1 - r));
  return dx * dx + dy * dy <= r * r;
};
const ellipse = (
  px: number,
  py: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number
) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
const geometry: Record<
  AgentLook["shape"],
  { inBody: (x: number, y: number) => boolean; eyeY: number }
> = {
  block: { inBody: (x, y) => roundRect(x, y, 4, 6, 20, 21, 2.6), eyeY: 10 },
  bean: { inBody: (x, y) => ellipse(x, y, 12, 13.6, 7.9, 8.1), eyeY: 10 },
  tall: { inBody: (x, y) => roundRect(x, y, 5, 5, 19, 21.5, 4.2), eyeY: 9 },
  wide: { inBody: (x, y) => ellipse(x, y, 12, 14.6, 9.3, 6.9), eyeY: 12 }
};
type Pixel = { x: number; y: number; fill: string; opacity?: number };
const pixel = (
  x: number,
  y: number,
  fill: string,
  opacity?: number
): Pixel => ({ x, y, fill, opacity });
function drawPixelkin(look: AgentLook): {
  body: Pixel[];
  face: Pixel[];
  eyeY: number;
  outline: string;
} {
  const g = geometry[look.shape] ?? geometry.block;
  const c = PIXELKIN_PALETTE[look.color] ?? PIXELKIN_PALETTE.violet;
  let inBody = g.inBody;
  if (look.top === "ears") {
    const base = inBody;
    let top = 99;
    for (let y = 0; y < 24; y++)
      if (base(5.5, y + 0.5)) {
        top = y;
        break;
      }
    inBody = (x, y) =>
      base(x, y) ||
      (x > 4.5 &&
        x < 8.5 &&
        y < top + 1 &&
        y > top - 3 + Math.abs(x - 6.5) * 1.2) ||
      (x > 15.5 &&
        x < 19.5 &&
        y < top + 1 &&
        y > top - 3 + Math.abs(x - 17.5) * 1.2);
  }
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < 24 && y < 24 && inBody(x + 0.5, y + 0.5);
  let minY = 24,
    maxY = 0;
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++)
      if (on(x, y)) {
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
  const body: Pixel[] = [];
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      if (!on(x, y)) continue;
      const edge =
        !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
      let fill = c[1];
      if (edge) fill = c[3];
      else if (y >= maxY - 1) fill = c[2];
      else if (y >= maxY - 5 && (x + y) % 2 === 0) fill = c[2];
      else if (!on(x - 2, y) && y < minY + 6) fill = c[0];
      body.push(pixel(x, y, fill));
    }
  let topY = 99;
  for (let y = 0; y < 24; y++)
    if (on(12, y)) {
      topY = y;
      break;
    }
  if (look.top === "antenna") {
    for (let y = topY - 3; y < topY; y++) body.push(pixel(12, y, c[3]));
    [
      [11, -5],
      [12, -5],
      [11, -4],
      [12, -4],
      [13, -5],
      [10, -5],
      [11, -6],
      [12, -6]
    ].forEach(([x, dy]) => body.push(pixel(x!, topY + dy!, c[3])));
    body.push(pixel(11, topY - 5, c[1]), pixel(12, topY - 5, c[1]));
  }
  if (look.top === "sprout") {
    body.push(pixel(12, topY - 1, "#145a32"), pixel(12, topY - 2, "#145a32"));
    [
      [9, -4],
      [10, -4],
      [10, -3],
      [11, -3],
      [14, -4],
      [15, -4],
      [13, -3],
      [14, -3]
    ].forEach(([x, dy]) => body.push(pixel(x!, topY + dy!, "#3fbf72")));
    [
      [8, -4],
      [9, -5],
      [10, -5],
      [15, -5],
      [14, -5],
      [16, -4]
    ].forEach(([x, dy]) => body.push(pixel(x!, topY + dy!, "#145a32")));
  }
  let highlight = -1;
  for (let x = 0; x < 24; x++)
    if (on(x, minY + 2)) {
      highlight = x + 2;
      break;
    }
  if (highlight > 0 && on(highlight, minY + 2))
    body.push(pixel(highlight, minY + 2, "#ffffff", 0.85));
  const ey = g.eyeY;
  const face = [
    pixel(7, ey - 2, c[3]),
    pixel(8, ey - 2, c[3]),
    pixel(9, ey - 2, c[3]),
    pixel(14, ey - 2, c[3]),
    pixel(15, ey - 2, c[3]),
    pixel(16, ey - 2, c[3]),
    pixel(10, ey + 5, c[3]),
    pixel(13, ey + 5, c[3]),
    pixel(11, ey + 6, c[3]),
    pixel(12, ey + 6, c[3]),
    pixel(6, ey + 5, "#ff7aa8", 0.55),
    pixel(7, ey + 5, "#ff7aa8", 0.55),
    pixel(16, ey + 5, "#ff7aa8", 0.55),
    pixel(17, ey + 5, "#ff7aa8", 0.55)
  ];
  return { body, face, eyeY: ey, outline: c[3] };
}
export function Pixelkin({
  look = DEFAULT_AGENT_LOOK,
  size = 28,
  className = ""
}: {
  look?: AgentLook;
  size?: number;
  className?: string;
}) {
  const { body, face, eyeY, outline } = drawPixelkin(look);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = svg.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2),
          dy = event.clientY - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy);
        const x =
          distance > rect.width * 0.35
            ? Math.round(Math.max(-1, Math.min(1, (dx / distance) * 1.5)))
            : 0;
        const y =
          distance > rect.width * 0.35
            ? Math.round(Math.max(-1, Math.min(1, (dy / distance) * 1.5)))
            : 0;
        svg.style.setProperty("--v1-eye-x", String(x));
        svg.style.setProperty("--v1-eye-y", String(y));
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <svg
      ref={svgRef}
      className={`v1-pixelkin ${className}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {body.map((p, i) => (
        <rect
          key={`b${i}`}
          x={p.x}
          y={p.y}
          width="1"
          height="1"
          fill={p.fill}
          opacity={p.opacity}
        />
      ))}
      <g className="v1-pixelkin-open">
        <rect x="7" y={eyeY} width="4" height="4" fill="#fff" />
        <rect x="13" y={eyeY} width="4" height="4" fill="#fff" />
        <g className="v1-pixelkin-pupils">
          <rect x="8" y={eyeY + 1} width="2" height="2" fill={outline} />
          <rect x="14" y={eyeY + 1} width="2" height="2" fill={outline} />
        </g>
      </g>
      <g className="v1-pixelkin-shut">
        <rect x="7" y={eyeY + 2} width="4" height="1" fill={outline} />
        <rect x="13" y={eyeY + 2} width="4" height="1" fill={outline} />
      </g>
      {face.map((p, i) => (
        <rect
          key={`f${i}`}
          x={p.x}
          y={p.y}
          width="1"
          height="1"
          fill={p.fill}
          opacity={p.opacity}
        />
      ))}
    </svg>
  );
}
export function AgentLookPicker({
  look,
  onChange
}: {
  look: AgentLook;
  onChange: (look: AgentLook) => void;
}) {
  return (
    <div className="v1-look-picker">
      <div className="v1-field">
        <span>Shape</span>
        <div className="v1-options">
          {shapes.map((shape) => (
            <button
              type="button"
              key={shape}
              className="v1-look-option"
              aria-label={`${shape} shape`}
              aria-pressed={look.shape === shape}
              onClick={() => onChange({ ...look, shape })}
            >
              <Pixelkin look={{ ...look, shape, top: "none" }} size={34} />
            </button>
          ))}
        </div>
      </div>
      <div className="v1-field">
        <span>Colour</span>
        <div className="v1-options v1-swatches">
          {(Object.keys(PIXELKIN_PALETTE) as AgentLook["color"][]).map(
            (color) => (
              <button
                type="button"
                key={color}
                className="v1-swatch"
                style={{ background: PIXELKIN_PALETTE[color][1] }}
                aria-label={color}
                aria-pressed={look.color === color}
                onClick={() => onChange({ ...look, color })}
              />
            )
          )}
        </div>
      </div>
      <div className="v1-field">
        <span>On top</span>
        <div className="v1-options">
          {tops.map((top) => (
            <button
              type="button"
              key={top}
              className="v1-look-option"
              aria-label={topNames[top]}
              title={topNames[top]}
              aria-pressed={look.top === top}
              onClick={() => onChange({ ...look, top })}
            >
              <Pixelkin look={{ ...look, top }} size={34} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

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
