import type { CollaborationApprovalReview } from "@koed/shared";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { randomUUID } from "node:crypto";

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  );

/** HTML is rendered only in an isolated Electron-owned modal. All remote
 * review copy is text, and the page has no script or network capability. */
export const projectSharePolicyReviewHtml = (
  review: CollaborationApprovalReview,
  approveUrl: string
): string => {
  const rows = (review.reviewSources ?? [])
    .map(
      (source, index) =>
        `<li><span class="number">${index + 1}.</span><span>${escapeHtml(source.reviewLabel)}</span><span class="state">${source.eligible ? "Eligible" : "Excluded"}</span></li>`
    )
    .join("");
  const details = review.details
    .map(
      (detail) =>
        `<dt>${escapeHtml(detail.label)}</dt><dd>${escapeHtml(detail.value)}</dd>`
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://koed.invalid; base-uri 'none'; frame-ancestors 'none'"><title>${escapeHtml(review.title)}</title><style>
    :root{color-scheme:light dark;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;background:Canvas;color:CanvasText}main{display:flex;flex-direction:column;height:100vh;box-sizing:border-box;padding:28px 30px;gap:16px}
    h1{font-size:21px;line-height:1.25;margin:0}p{line-height:1.5;margin:0}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{font-weight:600}dd{margin:0}
    section{min-height:0;display:flex;flex-direction:column;gap:8px;flex:1}h2{font-size:15px;margin:0}ol{overflow:auto;min-height:120px;flex:1;margin:0;padding:0;list-style:none;border:1px solid GrayText;border-radius:8px}li{display:grid;grid-template-columns:2em minmax(0,1fr) auto;gap:8px;padding:9px 12px;border-bottom:1px solid GrayText;overflow-wrap:anywhere}li:last-child{border-bottom:0}.state{font-weight:600}.number{color:GrayText}
    footer{border-top:1px solid GrayText;padding-top:14px;display:flex;flex-direction:column;gap:14px}form{display:flex;justify-content:flex-end;gap:9px}button{font:inherit;font-weight:600;padding:9px 18px;border:0;border-radius:7px;color:white;background:#155bca;cursor:pointer}.cancel{color:CanvasText;background:ButtonFace;border:1px solid GrayText}
  </style></head><body><main><h1>${escapeHtml(review.title)}</h1><p>${escapeHtml(review.description)}</p><dl>${details}</dl><section><h2>Captured Sessions (${review.reviewSources?.length ?? 0})</h2><ol>${rows}</ol></section><footer><p>${escapeHtml(review.consequence)}</p><form action="${escapeHtml(approveUrl)}" method="get"><button class="cancel" type="submit" formaction="${escapeHtml(approveUrl)}/cancel">Cancel</button><button type="submit">${escapeHtml(review.confirmLabel)}</button></form></footer></main></body></html>`;
};

/** The Electron main process owns this modal and its decision. The caller must
 * bind `ownerId` to the requesting WebContents, never to a renderer payload. */
export const showProjectSharePolicyNativeReview = async (input: {
  review: CollaborationApprovalReview;
  parent: BrowserWindow;
  ownerId: string;
  signal: AbortSignal;
  currentParent(): BrowserWindow | null;
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
}): Promise<boolean> => {
  const { parent, review } = input;
  if (
    parent.isDestroyed() ||
    String(parent.webContents.id) !== input.ownerId ||
    input.currentParent() !== parent ||
    input.signal.aborted
  )
    throw new Error("Project summary sharing window changed");
  const approveUrl = `https://koed.invalid/project-policy-approve/${randomUUID()}`;
  const modal = input.createWindow({
    parent,
    modal: true,
    show: false,
    width: 760,
    height: 650,
    minWidth: 640,
    minHeight: 480,
    title: review.title,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  modal.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return await new Promise<boolean>((resolveReview, rejectReview) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener("abort", onAbort);
      resolveReview(
        approved &&
          !input.signal.aborted &&
          input.currentParent() === parent &&
          !parent.isDestroyed() &&
          String(parent.webContents.id) === input.ownerId
      );
      if (!modal.isDestroyed()) modal.close();
    };
    const onAbort = () => finish(false);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) finish(false);
    modal.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      if (url === approveUrl || url === `${approveUrl}?`) finish(true);
      if (url === `${approveUrl}/cancel` || url === `${approveUrl}/cancel?`)
        finish(false);
    });
    modal.webContents.on("before-input-event", (_event, key) => {
      if (key.key === "Escape") finish(false);
    });
    modal.webContents.on("will-redirect", (event) => event.preventDefault());
    modal.on("closed", () => finish(false));
    modal.once("ready-to-show", () => modal.show());
    modal
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(projectSharePolicyReviewHtml(review, approveUrl))}`
      )
      .catch((error: unknown) => {
        if (!settled) {
          settled = true;
          input.signal.removeEventListener("abort", onAbort);
          rejectReview(error);
        }
        if (!modal.isDestroyed()) modal.close();
      });
  });
};
