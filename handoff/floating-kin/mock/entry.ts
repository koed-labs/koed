// Mock UI for the floating Kin: per-session chips (project Kin + client logo), one panel. All data is fake.
import { addPixelkin, createPixelkinActor, hopPixelkin, setPixelkinExpression, wakePixelkins } from "../../../apps/desktop/src/renderer/v1/pixelkin/stage.ts";
import { projectKinLook } from "../../../apps/desktop/src/renderer/v1/pixelkin/agent-kin.ts";
import { KIN_COLOURS, KIN_DEFAULTS, clone, editKin } from "../../../apps/desktop/src/renderer/v1/pixelkin/vendor/index.js";
const { ipcRenderer } = require("electron");

type S = "rest" | "idle" | "working" | "answer" | "project" | "stopped" | "signedout" | "quiet";
type Client = "claude" | "codex" | "pi";
type Sess = { project: string; client: Client; clientName: string; title: string; mins: number; working: boolean; where: string; now: string; why: string; chips: string[]; steps: number };
const sessions: Sess[] = [
  { project: "koed-api", client: "claude", clientName: "Claude Code", title: "Refactor billing webhooks", mins: 11, working: true, steps: 42,
    where: "Step 6 of 9. It moved the retry logic into <code>webhook-dispatcher.ts</code> and is re-running the billing tests.",
    now: "Running <code>pnpm test billing</code>. The last run failed 2 of 14 tests, both in the retry timing suite.",
    why: "It is chasing a timeout. Its last three edits all changed backoff timing, so it likely suspects the new delay calculation.",
    chips: ["Edit webhook-dispatcher.ts · 14:31:42", "Reasoning · 14:31:58", "Ran pnpm test billing · 14:32:04"] },
  { project: "mobile-app", client: "codex", clientName: "Codex", title: "Fix offline sync conflicts", mins: 3, working: true, steps: 17,
    where: "Early on. It has read the sync queue and written a failing test for duplicate pushes.",
    now: "Editing <code>queue.ts</code> to add a per-record version check.",
    why: "The failing test shows two devices overwriting each other, so it is adding version checks before touching the UI.",
    chips: ["Read sync/queue.ts · 14:29:51", "Wrote queue.test.ts · 14:30:40", "Edit queue.ts · 14:32:01"] },
  { project: "docs-site", client: "pi", clientName: "Pi", title: "Rewrite install guide", mins: 24, working: false, steps: 63,
    where: "Finished the macOS section and stopped. The Linux section is still a stub.",
    now: "Nothing running. The last captured step was a file write 24 minutes ago.",
    why: "It may be waiting for you. Its last message asks whether to document the AppImage path.",
    chips: ["Wrote install.md · 14:08:12", "Message · 14:08:30"] }
];
let state: S = "rest", prev: S = "idle", sel = 0, mini = false, timer: number | undefined, theme = "";
const hhmmss = (d: Date) => d.toTimeString().slice(0, 8);
let answeredAt = new Date();

const root = document.getElementById("root")!;
root.innerHTML = `<div id="host"></div><div id="dock" class="dock"></div><div class="row"><div id="pill" class="pill hit"></div><div id="kin" class="kin hit" role="button" tabindex="0" aria-label="Open Chief of Staff"><canvas id="cv"></canvas></div></div><div id="keys" class="keys hit" hidden></div>`;
const host = document.getElementById("host")!, dock = document.getElementById("dock")!, pill = document.getElementById("pill")!, kinEl = document.getElementById("kin")!;
const cv = document.getElementById("cv") as HTMLCanvasElement;

// The engine idles whenever its window is unfocused; an overlay is almost always unfocused.
document.hasFocus = () => true;
window.addEventListener("blur", () => setTimeout(wakePixelkins, 0));
setInterval(wakePixelkins, 1000);

const look = clone(KIN_DEFAULTS);
const indigo = KIN_COLOURS.find((c: any) => c.name === "Indigo");
if (indigo) editKin(look, "palette.base", indigo.hex);
editKin(look, "body.shape", "roundedBox"); editKin(look, "body.height", 1.6);
const actor = createPixelkinActor(cv, look, 72, "avatar");
addPixelkin(actor);

// Chips: built once per mode so each project Kin keeps its canvas and animation.
let removers: Array<() => void> = [];
function buildDock() {
  removers.forEach((r) => r()); removers = [];
  dock.innerHTML = "";
  sessions.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = `chip-s hit ${mini ? "mini" : ""}`; el.dataset.i = String(i); el.tabIndex = 0; el.setAttribute("role", "button");
    el.setAttribute("aria-label", `${s.project}, ${s.clientName}, ${s.working ? "working" : "idle"} ${s.mins} minutes`);
    el.innerHTML = `<span class="av"><canvas></canvas><i class="logo" style="--logo:url(icons/${{ claude: "anthropic", codex: "openai", pi: "pi-coding-agent" }[s.client]}.svg)"></i></span><span class="dot ${s.working ? "" : "idle"}"></span><span class="dur">${s.mins}m</span><span class="lbl">${s.project}</span>`;
    dock.appendChild(el);
    const c = el.querySelector("canvas") as HTMLCanvasElement;
    const a = createPixelkinActor(c, projectKinLook(s.project), 38, "avatar");
    removers.push(addPixelkin(a));
  });
  mark();
}
const mark = () => dock.querySelectorAll<HTMLElement>(".chip-s").forEach((e) => e.classList.toggle("sel", state !== "rest" && Number(e.dataset.i) === sel && !["stopped", "signedout", "quiet"].includes(state)));

const chip = (t: string) => `<button class="chip" title="Opens this captured step in Koed">${t}</button>`;
const S = () => sessions[sel]!;
const logo = (c: Client) => `<i class="logo sm" style="--logo:url(icons/${{ claude: "anthropic", codex: "openai", pi: "pi-coding-agent" }[c]}.svg)"></i>`;
const title = () => state === "project" ? `Project: ${S().project}` : state === "stopped" || state === "signedout" ? "Chief of Staff" : state === "quiet" ? "No recent activity" : S().title;
const meta = () => state === "project" ? "From completed work · 3 sessions this week" : state === "stopped" ? "Local runtime stopped" : state === "signedout" ? "AI Client needs attention" : state === "quiet" ? "Last captured activity 2 h ago" : `${logo(S().client)} ${S().clientName} · ${S().project} · ${S().working ? "running" : "idle"} ${S().mins} min`;
const panel = (inner: string, foot = "") => `<div class="panel hit" role="dialog" aria-label="Chief of Staff"><div class="head" data-drag><span class="dot ${state === "stopped" || state === "signedout" ? "warn" : state === "quiet" || !S().working ? "idle" : ""}"></span><div class="t"><b>${title()}</b><small>${meta()}</small></div><button class="x" data-act="close" aria-label="Collapse">✕</button></div>${inner}${foot}</div>`;

const views: Record<string, () => string> = {
  idle: () => panel(`<div class="body"><div class="btns">
    <button class="b p" data-act="summarize">Summarize this session<small>captured activity</small></button>
    <button class="b" data-act="project">Catch me up on the project<small>completed work</small></button></div>
    <div class="note">Reads what Koed has captured, about 2 seconds behind the agent. Uses your ${S().clientName} subscription.</div></div>`),
  working: () => panel(`<div class="body"><div class="sec"><h4>Reading ${S().steps} captured steps…</h4></div><div class="shimmer" style="width:92%"></div><div class="shimmer" style="width:76%"></div><div class="shimmer" style="width:84%"></div>
    <div class="btns"><button class="b" data-act="cancel">Cancel</button></div></div>`),
  answer: () => panel(`<div class="body">
    <div class="sec"><h4>Where it is</h4><p>${S().where}</p></div>
    <div class="sec"><h4>Doing now <span class="tag">Observed</span></h4><p>${S().now}</p></div>
    <div class="sec"><h4>Why <span class="tag w">Inferred</span></h4><p>${S().why}</p></div>
    <div class="chips">${S().chips.map(chip).join("")}</div></div>`,
    `<div class="foot"><span>As of ${hhmmss(answeredAt)} · 4s ago · ${S().steps} steps</span><span class="sp"></span><button data-act="summarize">Refresh</button><button data-act="project">Project</button></div>`),
  project: () => panel(`<div class="body">
    <div class="sec"><h4>This week <span class="tag">From completed work</span></h4><p>Three sessions, mostly on this area. The main design decision was made on Tuesday after a bug report.</p></div>
    <div class="sec"><h4>Still open</h4><p>One follow-up from Thursday has no session yet. Today's work is heading towards it.</p></div>
    <div class="chips">${chip("Earlier design session · Tue")}${chip("Bug investigation · Wed")}${chip("Follow-up notes · Thu")}</div></div>`,
    `<div class="foot"><span>As of the last finished session · 2 h ago</span><span class="sp"></span><button data-act="summarize">This session</button></div>`),
  stopped: () => panel(`<div class="body"><div class="sec"><p>Koed is stopped, so there's nothing to read. You stopped it, so I won't start it for you.</p></div><div class="btns"><button class="b p" data-act="start">Start Koed</button></div></div>`),
  signedout: () => panel(`<div class="body"><div class="sec"><p>${S().clientName} is signed out, so I can't write summaries. I won't switch to another AI Client.</p></div><div class="btns"><button class="b p" data-act="models">Open AI models</button></div></div>`),
  quiet: () => panel(`<div class="body"><div class="sec"><p>Nothing has been captured in the last few minutes. I can still catch you up on a project.</p></div><div class="btns"><button class="b" data-act="project">Catch me up on the project<small>completed work</small></button></div></div>`)
};

function pillHtml() {
  if (state === "stopped") return `<span class="dot warn"></span>Koed stopped`;
  if (state === "signedout") return `<span class="dot warn"></span>Sign in needed`;
  if (state === "quiet") return `<span class="dot idle"></span><span>No recent activity</span>`;
  return "";
}
function render() {
  const open = state !== "rest";
  host.innerHTML = open ? views[state]!() : "";
  const p = pillHtml();
  pill.innerHTML = p; pill.style.display = p && !open ? "flex" : "none";
  dock.style.display = ["stopped", "signedout", "quiet"].includes(state) ? "none" : "flex";
  kinEl.classList.toggle("sleep", state === "quiet");
  setPixelkinExpression(actor, state === "stopped" || state === "signedout" ? "sad" : state === "answer" || state === "project" ? "happy" : "neutral");
  mark();
}
function go(next: S) { clearTimeout(timer); prev = state === "working" ? prev : state; state = next; if (next === "answer") { answeredAt = new Date(Date.now() - 4000); hopPixelkin(actor); } render(); }
function summarize() { go("working"); timer = window.setTimeout(() => go("answer"), 2600); }

host.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("[data-act]")?.getAttribute("data-act");
  if (a === "close") go("rest"); else if (a === "summarize") summarize(); else if (a === "project") go("project");
  else if (a === "cancel") go(prev === "working" ? "idle" : prev); else if (a === "start") go("idle"); else if (a === "models") go("idle");
});
dock.addEventListener("click", (e) => {
  const i = (e.target as HTMLElement).closest(".chip-s")?.getAttribute("data-i"); if (i === null || i === undefined) return;
  const n = Number(i); if (state !== "rest" && sel === n) go("rest"); else { sel = n; go("idle"); }
});
pill.addEventListener("click", () => go("idle"));

let drag: { x: number; y: number; moved: boolean; kin: boolean } | null = null;
document.addEventListener("mousedown", (e) => { const t = e.target as HTMLElement; const k = !!t.closest("#kin"); if (k || t.closest("[data-drag]")) drag = { x: e.screenX, y: e.screenY, moved: false, kin: k }; });
document.addEventListener("mousemove", (e) => {
  const over = !!(e.target as HTMLElement).closest(".hit");
  ipcRenderer.send("ignore", drag ? false : !over);
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.moved) { ipcRenderer.send("move", dx, dy); drag.x = e.screenX; drag.y = e.screenY; }
});
document.addEventListener("mouseup", () => { if (drag?.kin && !drag.moved) go(state === "rest" ? "idle" : "rest"); drag = null; });
kinEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(state === "rest" ? "idle" : "rest"); });

const map: Record<string, () => void> = { "1": () => go("rest"), "2": () => go("idle"), "3": () => go("working"), "4": () => go("answer"), "5": () => go("project"), "6": () => go("stopped"), "7": () => go("signedout"), "8": () => go("quiet"), Escape: () => go("rest"), q: () => ipcRenderer.send("quit"),
  s: () => { sel = (sel + 1) % sessions.length; render(); }, m: () => { mini = !mini; buildDock(); },
  d: () => { theme = theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = theme; },
  h: () => { const k = document.getElementById("keys")!; k.hidden = !k.hidden; } };
document.addEventListener("keydown", (e) => { const f = map[e.key]; if (f && !e.metaKey && !e.ctrlKey) { e.preventDefault(); f(); } });
document.getElementById("keys")!.textContent = "1 resting  2 actions  3 reading\n4 answer   5 project  6 stopped\n7 signed out  8 quiet\ns next session  m mini chips\nd theme  h hide  q quit\ndrag Kin or header to move";
if (matchMedia("(prefers-color-scheme: dark)").matches) { theme = "dark"; document.documentElement.dataset.theme = "dark"; }
(window as any).__go = go; (window as any).__sel = (n: number) => { sel = n; render(); }; (window as any).__mini = (m: boolean) => { mini = m; buildDock(); };
(window as any).__theme = (t: string) => { theme = t; document.documentElement.dataset.theme = t; };
buildDock(); render();
