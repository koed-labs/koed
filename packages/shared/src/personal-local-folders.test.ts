import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPersonalFolderDirectory,
  personalFolderDirectoryMarkerMatches,
  readPersonalFolderDirectoryMarker
} from "./personal-local-folders.js";

const volume = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const otherVolume = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const marker = (device = "17", inode = "123", birth = "456") =>
  JSON.stringify([device, inode, birth]);
const live = {
  marker: marker(`volume:${volume}`),
  deviceMarker: marker()
};
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("native Folder directory lifetime", () => {
  it("survives a changed mount number and requires the same inode and creation time", () => {
    expect(personalFolderDirectoryMarkerMatches(marker("19"), live)).toBe(true);
    expect(
      personalFolderDirectoryMarkerMatches(live.marker, {
        ...live,
        deviceMarker: marker("21")
      })
    ).toBe(true);
    for (const recorded of [
      marker("19", "999"),
      marker("19", "123", "999"),
      marker(`volume:${otherVolume}`),
      marker("19", "0"),
      '["19","123"]',
      "malformed"
    ])
      expect(personalFolderDirectoryMarkerMatches(recorded, live)).toBe(false);
    expect(
      personalFolderDirectoryMarkerMatches(marker("19"), {
        marker: marker(),
        deviceMarker: marker()
      })
    ).toBe(false);
    expect(
      personalFolderDirectoryMarkerMatches(live.marker, {
        marker: marker(),
        deviceMarker: marker()
      })
    ).toBe(false);
  });

  it("chooses one current registration while retaining host, path, and lifetime boundaries", () => {
    const entry = {
      deploymentId: "deployment",
      deviceId: "device",
      normalizedPath: "/repo",
      marker: marker("19"),
      folderId: "original",
      incarnationId: "lifetime"
    };
    const current = { ...entry, marker: marker(), folderId: "current" };
    const entries = [entry, current];
    const find = (
      path = "/repo",
      device = "device",
      deployment = "deployment"
    ) => findPersonalFolderDirectory(entries, path, deployment, device, live);
    expect(find()).toBe(current);
    expect(find("/repo/child")).toBeUndefined();
    expect(find("/repo", "other-device")).toBeUndefined();
    expect(find("/repo", "device", "other-deployment")).toBeUndefined();
    expect(
      findPersonalFolderDirectory(
        [entry],
        "/repo",
        "deployment",
        "device",
        live
      )
    ).toBe(entry);
    expect(
      findPersonalFolderDirectory([entry], "/repo", "deployment", "device", {
        marker: marker(`volume:${volume}`, "999"),
        deviceMarker: marker("17", "999")
      })
    ).toBeUndefined();
    const stable = { ...entry, marker: live.marker };
    expect(
      findPersonalFolderDirectory(
        [stable, current],
        "/repo",
        "deployment",
        "device",
        live
      )
    ).toBe(stable);
    expect(
      findPersonalFolderDirectory(
        [{ ...stable, marker: marker(`volume:${otherVolume}`) }, current],
        "/repo",
        "deployment",
        "device",
        live
      )
    ).toBeUndefined();
    expect(
      findPersonalFolderDirectory(
        [stable, current],
        "/repo",
        "deployment",
        "device",
        { marker: marker(), deviceMarker: marker() }
      )
    ).toBeUndefined();
  });

  it("rejects a real replacement directory even when its volume stays the same", () => {
    const parent = resolve(
      import.meta.dirname,
      "../../../scratch/folder-remount-fix/tests"
    );
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(resolve(parent, "lifetime-"));
    temporary.push(root);
    const path = resolve(root, "checkout");
    mkdirSync(path);
    const first = readPersonalFolderDirectoryMarker(
      path,
      new Map([[statSync(path, { bigint: true }).dev, volume]])
    )!;
    expect(first.marker).toContain(`"volume:${volume}"`);
    // Keep the old inode allocated: Linux can reuse an unlinked inode within
    // the same filesystem timestamp tick when this directory is recreated.
    renameSync(path, resolve(root, "previous-checkout"));
    mkdirSync(path);
    const replacement = readPersonalFolderDirectoryMarker(
      path,
      new Map([[statSync(path, { bigint: true }).dev, volume]])
    )!;
    expect(
      personalFolderDirectoryMarkerMatches(first.marker, replacement)
    ).toBe(false);
    expect(
      personalFolderDirectoryMarkerMatches(first.deviceMarker, replacement)
    ).toBe(false);
  });
});
