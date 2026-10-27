import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const validationRoot = fileURLToPath(
  new URL("../dist-validation/", import.meta.url)
);
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

/** Load synthetic assets into the trusted test renderer without changing the package. */
export async function loadRendererValidation(
  cdp,
  { view, actor },
  root = validationRoot
) {
  const html = await readFile(resolve(root, "browser-validation.html"), "utf8");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      const within = relative(root, path);
      if (within.startsWith("..") || isAbsolute(within)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      response
        .writeHead(200, {
          "Content-Type":
            contentTypes[extname(path)] ?? "application/octet-stream",
          "Access-Control-Allow-Origin": "koed://app"
        })
        .end(body);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const dispose = async () => {
    server.closeAllConnections();
    await new Promise((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    );
  };
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    // Keep the package origin and preload bridge. Only this debugger-controlled
    // test document may load the separate synthetic assets across origins.
    await cdp.call("Page.setBypassCSP", { enabled: true });
    const query = new URL("koed://app/");
    query.searchParams.set("view", view);
    query.searchParams.set("actor", actor);
    // Chromium applies CSP bypass when a document is initialized, so navigate
    // at the package origin before replacing its contents with the test fixture.
    await cdp.call("Page.navigate", { url: query.href });
    const installDocument = async (previousLoaderId) => {
      let ready = false;
      let frame;
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const { frameTree } = await cdp.call("Page.getFrameTree");
          frame = frameTree.frame;
          if (previousLoaderId && frame.loaderId === previousLoaderId) {
            await delay(25);
            continue;
          }
          const response = await cdp.call("Runtime.evaluate", {
            expression: `document.readyState === 'complete' && location.href === ${JSON.stringify(query.href)}`,
            returnByValue: true
          });
          ready = response.result?.value === true;
          if (ready) break;
        } catch {
          // A navigation briefly replaces the execution context.
        }
        await delay(25);
      }
      if (!ready)
        throw new Error("Package renderer did not finish fixture navigation");
      await cdp.call("Page.setDocumentContent", {
        frameId: frame.id,
        html: html.replace(
          /((?:src|href)=["'])\.\/assets\//gu,
          `$1${base}assets/`
        )
      });
    };
    await installDocument();
    return {
      dispose,
      async reload() {
        const { frameTree } = await cdp.call("Page.getFrameTree");
        const previousLoaderId = frameTree.frame.loaderId;
        if (!previousLoaderId)
          throw new Error("Package renderer loader is unavailable");
        await cdp.call("Page.reload", { ignoreCache: true });
        // A reload restores the packaged production document. Wait for the new
        // document before reinstalling synthetic assets at the same origin.
        await installDocument(previousLoaderId);
      }
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
