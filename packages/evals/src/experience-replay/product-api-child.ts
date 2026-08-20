type ParentMessage = { type: "close" };

let closing: Promise<void> | undefined;
let app:
  | Awaited<ReturnType<(typeof import("@koed/api"))["buildServer"]>>
  | undefined;

const close = (): Promise<void> => {
  if (!closing) {
    closing = (app ? app.close() : Promise.resolve()).then(() => {
      if (process.connected) process.send?.({ type: "closed" });
    });
  }
  return closing;
};

process.on("message", (message: ParentMessage) => {
  if (message?.type === "close") void close().finally(() => process.exit(0));
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => void close().finally(() => process.exit(0)));
}
process.once("disconnect", () => void close().finally(() => process.exit(0)));

try {
  const { buildServer } = await import("@koed/api");
  app = await buildServer({ runMemoryJobsInlineForTests: true });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Koed API did not publish a TCP address");
  }
  process.send?.({
    type: "listening",
    url: `http://127.0.0.1:${address.port}`
  });
} catch {
  process.send?.({ type: "startup-error" });
  await close().catch(() => undefined);
  process.exit(1);
}
