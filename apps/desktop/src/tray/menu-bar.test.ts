import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopMenuBar,
  createMenuBarMenuTemplate,
  createMenuBarStatusSnapshot,
  menuBarIconFilename
} from "./menu-bar.js";

const healthyStatus = () => ({
  generatedAt: "2026-08-12T10:44:00.000Z",
  api: { state: "healthy" },
  database: { state: "healthy" },
  redis: {
    state: "healthy",
    details: undefined as Record<string, unknown> | undefined
  },
  workerQueues: { state: "healthy" },
  embeddingService: { state: "healthy" },
  lcmSummaryService: { state: "healthy" }
});

describe("Desktop menu-bar status", () => {
  it.each([
    ["koed-trayTemplate.png", 18],
    ["koed-trayTemplate@2x.png", 36]
  ])("ships the %s grayscale-alpha asset", (file, size) => {
    const png = readFileSync(
      resolve(import.meta.dirname, "../../assets", file)
    );

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(4);
  });

  it("selects platform-appropriate tray assets", () => {
    expect(menuBarIconFilename("darwin")).toBe("koed-trayTemplate.png");
    expect(menuBarIconFilename("linux")).toBe("koed-tray-linux.png");
    expect(menuBarIconFilename("win32")).toBeNull();
  });

  it("ships an RGBA Linux tray asset", () => {
    const png = readFileSync(
      resolve(import.meta.dirname, "../../assets/koed-tray-linux.png")
    );

    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(24);
    expect(png.readUInt32BE(20)).toBe(24);
    expect(png[25]).toBe(6);
  });

  it("includes all tray assets in packaged Desktop builds", () => {
    const builderConfig = readFileSync(
      resolve(import.meta.dirname, "../../electron-builder.yml"),
      "utf8"
    );

    expect(builderConfig).toContain("assets/koed-trayTemplate.png");
    expect(builderConfig).toContain("assets/koed-trayTemplate@2x.png");
    expect(builderConfig).toContain("assets/koed-tray-linux.png");
    expect(builderConfig).toContain("assets/koed-tray-linux@2x.png");
  });

  it("summarizes the six operational service checks", () => {
    const status = healthyStatus();
    status.redis.state = "starting";

    const snapshot = createMenuBarStatusSnapshot(status);

    expect(snapshot.summary).toBe("5 of 6 services running — starting");
    expect(
      snapshot.services.map(({ label, stateLabel }) => [label, stateLabel])
    ).toEqual([
      ["API", "Running"],
      ["Database", "Running"],
      ["Redis", "Starting…"],
      ["Work queue", "Running"],
      ["Embedding Service", "Running"],
      ["LCM Summary Service", "Running"]
    ]);
  });

  it("prioritizes a service that needs attention in the summary", () => {
    const status = healthyStatus();
    status.redis.state = "starting";
    status.workerQueues.state = "needs_attention";

    expect(createMenuBarStatusSnapshot(status).summary).toBe(
      "4 of 6 services running — needs attention"
    );
  });

  it("does not count Redis when the local queue bypasses it", () => {
    const status = healthyStatus();
    status.redis.details = { backend: "local", required: false };

    const snapshot = createMenuBarStatusSnapshot(status);

    expect(snapshot.summary).toBe("5 of 5 services running");
    expect(snapshot.services.some((service) => service.key === "redis")).toBe(
      false
    );
  });

  it("builds a native menu with status, actions, and quit", () => {
    const template = createMenuBarMenuTemplate(
      createMenuBarStatusSnapshot(healthyStatus()),
      {
        openDesktop: vi.fn(),
        refresh: vi.fn(),
        quit: vi.fn()
      }
    );

    expect(template[0]).toEqual({
      label: "6 of 6 services running",
      enabled: false
    });
    expect(template.some((item) => item.label === "Open Koed")).toBe(true);
    expect(template.some((item) => item.label === "Refresh Status")).toBe(true);
    expect(template.some((item) => item.label === "Quit Koed")).toBe(true);
    expect(template.some((item) => item.label?.endsWith("— Running"))).toBe(
      false
    );
    expect(template.filter((item) => item.type === "separator")).toHaveLength(
      2
    );
  });

  it("only lists services that are not running normally", () => {
    const status = healthyStatus();
    status.redis.state = "starting";
    status.workerQueues.state = "needs_attention";

    const template = createMenuBarMenuTemplate(
      createMenuBarStatusSnapshot(status),
      {
        openDesktop: vi.fn(),
        refresh: vi.fn(),
        quit: vi.fn()
      }
    );

    expect(
      template.filter((item) =>
        item.label?.match(/— (Running|Starting…|Needs attention)$/)
      )
    ).toEqual([
      { label: "Redis — Starting…", enabled: false },
      { label: "Work queue — Needs attention", enabled: false }
    ]);
  });

  it("opens on left click and shows status on right click", async () => {
    let clickListener: (() => void) | null = null;
    let rightClickListener: (() => void) | null = null;
    const tray = {
      destroy: vi.fn(),
      onClick: vi.fn((listener: () => void) => {
        clickListener = listener;
      }),
      onRightClick: vi.fn((listener: () => void) => {
        rightClickListener = listener;
      }),
      popUpContextMenu: vi.fn(),
      setToolTip: vi.fn()
    };
    const openDesktop = vi.fn();
    const menuBar = createDesktopMenuBar({
      tray,
      buildMenu: (template) => template,
      getStatus: async () => healthyStatus(),
      openDesktop,
      quit: vi.fn(),
      pollIntervalMs: 60_000
    });
    await menuBar.refresh();

    const invokeClick = clickListener as (() => void) | null;
    const invokeRightClick = rightClickListener as (() => void) | null;
    invokeClick?.();
    invokeRightClick?.();

    expect(openDesktop).toHaveBeenCalledOnce();
    expect(tray.popUpContextMenu).toHaveBeenCalledOnce();
    const [menu] = tray.popUpContextMenu.mock.calls[0]!;
    expect(menu[0]).toEqual({
      label: "6 of 6 services running",
      enabled: false
    });

    menuBar.dispose();
    expect(tray.destroy).toHaveBeenCalledOnce();
  });

  it("attaches and refreshes the native Linux context menu", async () => {
    let clickListener: (() => void) | null = null;
    const tray = {
      destroy: vi.fn(),
      onClick: vi.fn((listener: () => void) => {
        clickListener = listener;
      }),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn()
    };
    const openDesktop = vi.fn();
    const menuBar = createDesktopMenuBar({
      tray,
      buildMenu: (template) => template,
      getStatus: async () => healthyStatus(),
      openDesktop,
      quit: vi.fn(),
      pollIntervalMs: 60_000
    });
    await menuBar.refresh();

    const invokeClick = clickListener as (() => void) | null;
    invokeClick?.();

    expect(openDesktop).toHaveBeenCalledOnce();
    expect(tray.setContextMenu).toHaveBeenCalledTimes(2);
    const [menu] = tray.setContextMenu.mock.calls.at(-1)!;
    expect(menu[0]).toEqual({
      label: "6 of 6 services running",
      enabled: false
    });

    menuBar.dispose();
  });
});
