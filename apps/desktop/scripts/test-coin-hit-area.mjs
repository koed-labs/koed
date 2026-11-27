// Run with: pnpm --filter @koed-labs/desktop exec electron scripts/test-coin-hit-area.mjs
import assert from "node:assert/strict";
import console from "node:console";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { app, BrowserWindow } from "electron";

const css = ["home/home.css", "coin/coin.css"]
  .map((file) =>
    readFileSync(new URL(`../src/renderer/v1/${file}`, import.meta.url), "utf8")
  )
  .join("\n");
const coin = (id, x, y, artwork) =>
  `<button id="${id}" class="v1-home-floor-coin v1-coin-host" data-motion="rest"
     style="--coin-x:${x}px;--coin-y:${y}px">${artwork}</button>`;
const vector = `<span class="v1-coin-vector" data-pose="standing" data-hover="show"
    style="width:20px;height:20px"><svg viewBox="0 0 32 32">
    <ellipse cx="16" cy="17" rx="14.25" ry="14"/><circle cx="16" cy="15" r="14"/>
    </svg></span>`;
const canvas = `<canvas class="v1-coin-canvas" data-hover="show"
    style="--coin-hit-shape:ellipse(27% 27% at 50% 50%)"></canvas>`;

async function verify(window, artwork) {
  const page = window.webContents;
  const html = `<!doctype html><style>${css}
    .v1-home-floor-coin { transition: none }</style>
    <div class="v1-home-floor">${coin("neighbor", 112, 92, "")}${coin("standing", 100, 80, artwork)}</div>
    <script>document.addEventListener('click', e => {
      document.body.dataset.clicked = e.target.closest('button')?.id;
    });</script>`;
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  const y = await page.executeJavaScript(
    "document.querySelector('#standing').getBoundingClientRect().top"
  );
  const input = (type, x, y, click = false) =>
    page.debugger.sendCommand("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      ...(click && { button: "left", clickCount: 1 })
    });
  async function clickAfterHover(x, clickY, expected) {
    await input("mouseMoved", 50, y);
    await input("mouseMoved", 100, y + 4);
    assert.equal(
      await page.executeJavaScript(
        "document.querySelector('#standing').matches(':hover')"
      ),
      true
    );
    await input("mouseMoved", x, clickY);
    await input("mousePressed", x, clickY, true);
    await input("mouseReleased", x, clickY, true);
    assert.equal(
      await page.executeJavaScript("document.body.dataset.clicked"),
      expected
    );
  }
  await clickAfterHover(100, y - 6, "standing");
  await clickAfterHover(112, y - 6, "neighbor");
}

app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({ width: 400, height: 300 });
    window.webContents.debugger.attach("1.3");
    await verify(window, vector);
    await verify(window, canvas);
    console.log("Coin hit testing passed for SVG and canvas.");
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
