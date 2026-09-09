import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  parseLinuxLoopbackListenerInodes,
  parseLsofLoopbackListenerPids,
  parseUnixProcessPairs,
  parseWindowsLoopbackListenerPids,
  verifyLoopbackListenerOwnership
} from "./listener-ownership.js";

describe("managed preview listener ownership parsing", () => {
  it("accepts only listening loopback sockets for the exact Linux port", () => {
    const value = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:143D 00000000:0000 0A 0:0 00:0 0 1000 0 4242 1 0",
      "   1: 00000000:143D 00000000:0000 0A 0:0 00:0 0 1000 0 4343 1 0",
      "   2: 0100007F:143E 00000000:0000 0A 0:0 00:0 0 1000 0 4444 1 0",
      "   3: 0100007F:143D 00000000:0000 01 0:0 00:0 0 1000 0 4545 1 0"
    ].join("\n");
    expect([...parseLinuxLoopbackListenerInodes(value, 5_181)]).toEqual([
      "4242"
    ]);
  });

  it("parses bounded Unix ancestry rows", () => {
    expect(parseUnixProcessPairs(" 10  1\n11 10\ninvalid\n")).toEqual([
      { pid: 10, parentPid: 1 },
      { pid: 11, parentPid: 10 }
    ]);
  });

  it("rejects wildcard lsof listeners", () => {
    const value = [
      "p100",
      "n127.0.0.1:5173 (LISTEN)",
      "p101",
      "n*:5173 (LISTEN)",
      "p102",
      "n[::1]:5173 (LISTEN)"
    ].join("\n");
    expect([...parseLsofLoopbackListenerPids(value, 5_173)]).toEqual([
      100, 102
    ]);
  });

  it("rejects wildcard Windows listeners", () => {
    const value = [
      "  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    200",
      "  TCP    0.0.0.0:5173      0.0.0.0:0    LISTENING    201",
      "  TCP    [::1]:5173        [::]:0       LISTENING    202"
    ].join("\n");
    expect([...parseWindowsLoopbackListenerPids(value, 5_173)]).toEqual([
      200, 202
    ]);
  });

  it.skipIf(process.platform !== "linux")(
    "proves a real loopback listener belongs to the nominated process",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "const http=require('node:http');const s=http.createServer((_q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));"
        ],
        { stdio: ["ignore", "pipe", "ignore"] }
      );
      const unrelated = spawn("/bin/sleep", ["30"], {
        stdio: "ignore"
      });
      try {
        const port = await new Promise<number>((resolvePort, rejectPort) => {
          const timeout = setTimeout(
            () => rejectPort(new Error("Listener did not start")),
            3_000
          );
          child.stdout.setEncoding("utf8");
          child.stdout.once("data", (value: string) => {
            clearTimeout(timeout);
            resolvePort(Number(value.trim()));
          });
          child.once("error", rejectPort);
        });
        await expect(
          verifyLoopbackListenerOwnership({ rootPid: child.pid!, port })
        ).resolves.toBe(true);
        await expect(
          verifyLoopbackListenerOwnership({ rootPid: unrelated.pid!, port })
        ).resolves.toBe(false);
      } finally {
        child.kill("SIGKILL");
        unrelated.kill("SIGKILL");
      }
    }
  );
});
