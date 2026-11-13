import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  claudeAgentSdkExecutableOptions,
  claudeAgentSdkProcessEnvironment,
  probeCodexVersion
} from "../src/ai-client-runner.js";
import { piExecutableInvocation } from "../src/pi-rpc-runner.js";

it("uses packaged Helper for Pi, Codex and Claude SDK JavaScript entries", async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "koed-packaged-runtime-"))
  );
  const runtime = join(root, "Koed.app/Contents/MacOS/Koed");
  const helper = join(
    root,
    "Koed.app/Contents/Frameworks/Koed Helper.app/Contents/MacOS/Koed Helper"
  );
  const entry = join(root, "cli.js");
  const output = join(root, "invocation.txt");
  const execDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform"
  )!;
  mkdirSync(dirname(helper), { recursive: true });
  writeFileSync(
    helper,
    `#!/bin/sh\nprintf '%s\\n' "$1" "$2" "$ELECTRON_RUN_AS_NODE" > "$OUTPUT"\necho 'codex 1.2.3'\n`
  );
  chmodSync(helper, 0o755);
  writeFileSync(entry, "");
  Object.defineProperty(process, "execPath", {
    value: runtime,
    configurable: true
  });
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true
  });
  try {
    expect(piExecutableInvocation(entry, ["--version"])).toEqual({
      command: helper,
      args: [entry, "--version"],
      nodeExecutable: helper
    });
    await expect(probeCodexVersion(entry, { OUTPUT: output })).resolves.toBe(
      "1.2.3"
    );
    expect(readFileSync(output, "utf8")).toBe(`${entry}\n--version\n1\n`);
    const env = claudeAgentSdkProcessEnvironment(entry, {}, "test");
    let command = "";
    let args: string[] = [];
    const options = claudeAgentSdkExecutableOptions(entry, ((
      cmd: string,
      argv: string[]
    ) => {
      command = cmd;
      args = argv;
      return {} as never;
    }) as never);
    expect(options.pathToClaudeCodeExecutable).toBe(entry);
    expect(options.spawnClaudeCodeProcess).toBeDefined();
    options.spawnClaudeCodeProcess!({
      command: "node",
      args: [entry, "--version"],
      cwd: root,
      env,
      signal: new AbortController().signal
    });
    expect({ command, args, nodeMode: env.ELECTRON_RUN_AS_NODE }).toEqual({
      command: helper,
      args: [entry, "--version"],
      nodeMode: "1"
    });
  } finally {
    Object.defineProperty(process, "execPath", execDescriptor);
    Object.defineProperty(process, "platform", platformDescriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
