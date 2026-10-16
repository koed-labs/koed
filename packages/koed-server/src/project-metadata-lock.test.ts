import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createNamedProject, listNamedProjects } from "./project-metadata.js";
import { resolveKoedServerPaths } from "./paths.js";

it("serializes the entire Project mutation against another process", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-project-transaction-")
  );
  const paths = resolveKoedServerPaths({
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  });
  const attempted = path.join(root, "attempted");
  const acquired = path.join(root, "acquired");
  let completion: Promise<number | null> | undefined;
  try {
    createNamedProject(paths, "Existing");
    createNamedProject(paths, "Desktop edit", {
      writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `
          const fs = require('node:fs');
          const lockfile = require('proper-lockfile');
          const [file,attempted,acquired] = process.argv.slice(1);
          fs.writeFileSync(attempted, 'ready');
          lockfile.lock(file, {realpath:false, retries:{retries:200,minTimeout:10,maxTimeout:10,factor:1}}).then(async release => {
            fs.writeFileSync(acquired, 'ready');
            const store = JSON.parse(fs.readFileSync(file, 'utf8'));
            const project = {...store.namedProjects[0], id:'project_concurrent', name:'Capture edit'};
            project.repository = {...project.repository,key:project.id};
            store.namedProjects.push(project);
            fs.writeFileSync(file,JSON.stringify(store));
            await release();
          }).catch(error => { console.error(error); process.exitCode=1; });
        `,
            paths.projectMetadataPath,
            attempted,
            acquired
          ],
          { cwd: path.resolve(import.meta.dirname, ".."), stdio: "ignore" }
        );
        completion = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", resolve);
        });
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(attempted)) {
          if (Date.now() >= deadline) throw new Error("Child did not start");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        expect(fs.existsSync(acquired)).toBe(false);
        return fs.writeFileSync(...args);
      }) as typeof fs.writeFileSync
    });
    await expect(completion).resolves.toBe(0);
    expect(listNamedProjects(paths).map((project) => project.name)).toEqual([
      "Existing",
      "Desktop edit",
      "Capture edit"
    ]);
    expect(fs.existsSync(`${paths.projectMetadataPath}.lock`)).toBe(false);
  } finally {
    await completion;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("preserves committed state after a failed write and releases the lock", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "koed-project-write-failure-")
  );
  const paths = resolveKoedServerPaths({
    KOED_HOME: root,
    KOED_REPO_ROOT: root
  });
  try {
    const existing = createNamedProject(paths, "Existing");
    const committed = fs.readFileSync(paths.projectMetadataPath, "utf8");
    const unavailable = () => {
      throw new Error("write unavailable");
    };
    expect(() =>
      createNamedProject(paths, "Failed edit", { writeFileSync: unavailable })
    ).toThrow("write unavailable");
    expect(fs.readFileSync(paths.projectMetadataPath, "utf8")).toBe(committed);
    expect(listNamedProjects(paths, { writeFileSync: unavailable })).toEqual([
      existing
    ]);
    expect(fs.readdirSync(paths.configDir)).toEqual(["projects.json"]);
    expect(createNamedProject(paths, "Later edit").name).toBe("Later edit");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
