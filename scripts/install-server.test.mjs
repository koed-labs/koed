import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  readlinkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const sourcePath = new URL("./install-server.sh", import.meta.url);

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "koed-installer-test-"));
  const marker = join(dir, "uname-called");
  writeFileSync(
    join(dir, "uname"),
    `#!/bin/sh\necho called >> "$MARKER"\ncase "$1" in -s) echo "\${HOST_OS:-Darwin}";; -m) echo "\${HOST_ARCH:-arm64}";; esac\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(dir, "sw_vers"),
    '#!/bin/sh\necho "${MACOS_VERSION:-14.0}"\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(dir, "getconf"),
    '#!/bin/sh\necho "${GLIBC_VERSION:-glibc 2.35}"\n',
    { mode: 0o755 }
  );
  const source = readFileSync(sourcePath, "utf8").replace(
    "__KOED_INSTALLER_VERSION__",
    "1.2.3"
  );
  return {
    dir,
    marker,
    source,
    env: {
      ...process.env,
      PATH: `${dir}:/usr/bin:/bin`,
      HOME: dir,
      KOED_HOME: join(dir, "home"),
      MARKER: marker
    }
  };
}

// Fake Node: answers version probes, stages the package for npm, and emulates
// the koed CLI JSON contracts. Failure modes come from a file because the
// installer runs the CLI with a sanitized environment.
const fakeNode = `#!/bin/sh
if [ "$1" = "--version" ]; then echo v26.13.0; exit; fi
if [ "$2" = "--version" ]; then echo 11.0.0; exit; fi
case "$1" in
*/bin/koed.js)
  shift
  mode=$(/bin/cat "$KOED_HOME/../fake-mode" 2>/dev/null)
  echo "$*" >> "$KOED_HOME/../koed-calls"
  /usr/bin/env > "$KOED_HOME/../koed-environment"
  case "$1 $2" in
  "components status") echo '{"components":{"base":"missing"},"activeVersion":null}' ;;
  "components install")
    if [ "$mode" = staged ]; then echo '{"state":"staged"}'; else echo '{"state":"active","generationId":"g"}'; fi ;;
  "runtime install")
    if [ "$mode" = runtime-fail ]; then echo '{"ok":false,"error":"offline"}'; exit 1; fi
    echo '{"ok":true,"provider":"release"}' ;;
  "models install") echo '{"ok":true,"state":"installed"}' ;;
  "start --daemon")
    /bin/sleep 120 > /dev/null 2>&1 &
    pid=$!
    echo "$pid" >> "$KOED_HOME/../fake-pids"
    /bin/mkdir -p "$KOED_HOME/run"
    if [ "$mode" = supervisor-dies ]; then kill "$pid"; wait "$pid" 2>/dev/null
    elif [ "$mode" = foreign-lock ]; then
      /bin/sleep 120 > /dev/null 2>&1 &
      echo "$!" >> "$KOED_HOME/../fake-pids"
      echo "{\\"pid\\":$!}" > "$KOED_HOME/run/koed-server.lock"
    else echo "{\\"pid\\":$pid}" > "$KOED_HOME/run/koed-server.lock"; fi
    echo "{\\"ok\\":true,\\"state\\":\\"starting\\",\\"startedPid\\":$pid}" ;;
  "status --startup") echo '{"ok":true,"state":"healthy"}' ;;
  "setup core") echo '{"ok":true,"state":"healthy","stdout":"SECRET-TOKEN"}' ;;
  "doctor --json") echo '{"ok":true,"state":"healthy"}' ;;
  *) exit 64 ;;
  esac
  exit ;;
esac
[ -z "$npm_config_userconfig" ] || [ "$npm_config_userconfig" != "$npm_config_globalconfig" ] || exit 7
[ -f "$npm_config_userconfig" ] && [ -f "$npm_config_globalconfig" ] || exit 8
printf '%s\\n' "$@" >> "$HOME/arguments"
pwd -P > "$HOME/working-directory"
/usr/bin/env > "$HOME/environment"
prefix=''
while [ $# -gt 0 ]; do
  if [ "$1" = '--prefix' ]; then shift; prefix="$1"; fi
  shift
done
[ -n "$prefix" ] || exit 2
/bin/mkdir -p "$prefix/node_modules/@koed-labs/server/bin"
printf '%s' '{"name":"@koed-labs/server","version":"1.2.3"}' > "$prefix/node_modules/@koed-labs/server/package.json"
printf '%s' 'fixture' > "$prefix/node_modules/@koed-labs/server/bin/koed.js"
`;

function trustedNode(f) {
  const nodeDir = join(f.dir, "trusted", "bin");
  const npmDir = join(f.dir, "trusted", "lib", "node_modules", "npm", "bin");
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(join(npmDir, "npm-cli.js"), "fixture");
  writeFileSync(join(nodeDir, "node"), fakeNode, { mode: 0o755 });
  return {
    ...f.env,
    PATH: `${f.dir}:${nodeDir}:/usr/bin:/bin`,
    KOED_INSTALL_POLL_SECONDS: "0"
  };
}

const calls = (f) =>
  existsSync(join(f.dir, "koed-calls"))
    ? readFileSync(join(f.dir, "koed-calls"), "utf8").trim().split("\n")
    : [];

function cleanup(f) {
  // Stop fake supervisors started by the fixture.
  if (existsSync(join(f.dir, "fake-pids")))
    for (const pid of readFileSync(join(f.dir, "fake-pids"), "utf8")
      .trim()
      .split("\n"))
      try {
        process.kill(Number(pid));
      } catch {
        // Already exited.
      }
  rmSync(f.dir, { recursive: true, force: true });
}

function run(source, env, args = ["--version", "1.2.3"]) {
  return spawnSync("/bin/bash", ["-s", "--", ...args], {
    input: source,
    env,
    encoding: "utf8"
  });
}

test("unrendered installer and invalid versions fail before host inspection", () => {
  const f = fixture();
  try {
    for (const [source, args] of [
      [readFileSync(sourcePath, "utf8"), ["--version", "1.2.3"]],
      [f.source, ["--version", "1.2.4"]],
      [f.source, ["--version", "1.2.3;echo bad"]],
      [f.source, ["--version"]],
      [f.source, ["1.2.3"]],
      [f.source, ["koed-installer-complete-v1"]],
      [f.source, ["--version", "1.2.3", "--extra"]]
    ]) {
      const result = run(source, f.env, args);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(existsSync(f.marker), false);
      assert.equal(existsSync(f.env.KOED_HOME), false);
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test(
  "every truncated byte prefix has no bootstrap side effects",
  { timeout: 600000 },
  async () => {
    const f = fixture();
    try {
      const bytes = Buffer.from(f.source);
      // Each prefix runs with and without the optional --version argument.
      let next = 0;
      const worker = async () => {
        while (next < bytes.length * 2) {
          const job = next++;
          const i = job >> 1;
          await new Promise((done, reject) => {
            const child = spawn(
              "/bin/bash",
              ["-s", "--", ...(job & 1 ? ["--version", "1.2.3"] : [])],
              { env: f.env, stdio: ["pipe", "ignore", "ignore"] }
            );
            child.on("error", reject);
            child.on("close", done);
            child.stdin.on("error", () => {});
            child.stdin.end(bytes.subarray(0, i));
          });
          assert.equal(
            existsSync(f.marker),
            false,
            `host inspection at byte ${i}`
          );
          assert.equal(
            existsSync(f.env.KOED_HOME),
            false,
            `home created at byte ${i}`
          );
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      const result = run(bytes, { ...f.env, HOST_OS: "unsupported" });
      assert.equal(
        existsSync(f.marker),
        true,
        "complete script must reach host inspection"
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsupported/i);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
);

test("installs, provisions, starts and verifies with a paired trusted Node; reruns safely", () => {
  const f = fixture();
  try {
    const env = {
      ...trustedNode(f),
      NODE_OPTIONS: "--require=/nonexistent",
      npm_config_registry: "https://invalid.example",
      KOED_DEPENDENCY_MODE: "external"
    };
    const result = run(f.source, env);
    assert.equal(result.status, 0, result.stderr);
    const home = realpathSync(f.env.KOED_HOME);
    const installer = join(home, "installer");
    const asset =
      "https://github.com/koed-labs/koed/releases/download/v1.2.3/koed-base-1.2.3-macos-arm64.tar.gz";
    assert.deepEqual(calls(f), [
      "components status --json",
      `components install --component base --version 1.2.3 --archive-url ${asset} --manifest-url ${asset}.manifest.json --json`,
      "runtime install --provider release --dependency-mode bundled-local --json",
      "models install --kind embedding --json",
      "start --daemon --json",
      "status --startup --json",
      "setup core --json",
      "doctor --json"
    ]);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-TOKEN/);
    assert.match(result.stdout, /installed and running/);
    assert.match(result.stdout, /No AI Client was configured/);
    const owner = JSON.parse(readFileSync(join(installer, "owner.json")));
    assert.equal(owner.state, "installed");
    assert.equal(owner.version, "1.2.3");
    assert.equal(owner.home, home);
    assert.equal(existsSync(join(installer, "lock")), false);

    const argumentsText = readFileSync(join(installer, "arguments"), "utf8");
    assert.match(argumentsText, /--ignore-scripts/);
    assert.match(argumentsText, /--engine-strict/);
    assert.match(argumentsText, /@koed-labs\/server@1\.2\.3/);
    assert.equal(
      readFileSync(join(installer, "working-directory"), "utf8").trim(),
      join(installer, "tmp", "package")
    );
    const npmEnvironment = readFileSync(join(installer, "environment"), "utf8");
    assert.doesNotMatch(npmEnvironment, /NODE_OPTIONS=/);
    assert.match(
      npmEnvironment,
      /npm_config_registry=https:\/\/registry\.npmjs\.org\//
    );
    const cliEnvironment = readFileSync(
      join(f.dir, "koed-environment"),
      "utf8"
    );
    assert.doesNotMatch(cliEnvironment, /NODE_OPTIONS=|KOED_DEPENDENCY_MODE=/);
    assert.match(cliEnvironment, new RegExp(`KOED_HOME=${home}\n`));

    const link = join(f.dir, ".local", "bin", "koed");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), join(installer, "bin", "koed"));
    const launched = spawnSync(link, ["doctor", "--json"], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8"
    });
    assert.equal(launched.status, 0, launched.stderr);
    assert.match(launched.stdout, /"ok":true/);
    assert.equal(calls(f).at(-1), "doctor --json");
    const conflicting = spawnSync(link, ["doctor"], {
      env: { PATH: "/usr/bin:/bin", KOED_HOME: "/elsewhere" },
      encoding: "utf8"
    });
    assert.notEqual(conflicting.status, 0);

    // Same-version rerun with the verified supervisor still running.
    rmSync(join(f.dir, "koed-calls"));
    const rerun = run(f.source, env);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.deepEqual(calls(f), [
      "status --startup --json",
      "setup core --json",
      "doctor --json"
    ]);
    assert.equal(
      readFileSync(join(installer, "arguments"), "utf8"),
      argumentsText,
      "package is not reinstalled"
    );
  } finally {
    cleanup(f);
  }
});

test("installs without arguments when piped as the short command", () => {
  const f = fixture();
  try {
    const result = run(f.source, trustedNode(f), []);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Koed Server 1\.2\.3 is installed and running/);
    assert.equal(calls(f).at(-1), "doctor --json");
  } finally {
    cleanup(f);
  }
});

test("partial provisioning failure reports the phase and resumes on rerun", () => {
  const f = fixture();
  try {
    const env = trustedNode(f);
    writeFileSync(join(f.dir, "fake-mode"), "runtime-fail");
    const failed = run(f.source, env);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /stopped during: native runtime install/);
    assert.match(failed.stderr, /rerun this installer/);
    assert.equal(calls(f).includes("start --daemon --json"), false);
    const installer = join(f.env.KOED_HOME, "installer");
    assert.equal(existsSync(join(installer, "lock")), false);
    const argumentsText = readFileSync(join(installer, "arguments"), "utf8");

    rmSync(join(f.dir, "fake-mode"));
    const resumed = run(f.source, env);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(calls(f).at(-1), "doctor --json");
    assert.equal(
      readFileSync(join(installer, "arguments"), "utf8"),
      argumentsText
    );
  } finally {
    cleanup(f);
  }
});

test("staged Base, dead supervisor and foreign supervisor are not readiness", () => {
  for (const [mode, message, forbidden] of [
    ["staged", /Base component install/, "runtime install"],
    ["supervisor-dies", /supervisor exited/, "setup core"],
    ["foreign-lock", /different supervisor/, "setup core"]
  ]) {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, "fake-mode"), mode);
      const result = run(f.source, trustedNode(f));
      assert.notEqual(result.status, 0, mode);
      assert.match(result.stderr, message);
      assert.equal(
        calls(f).some((call) => call.startsWith(forbidden)),
        false,
        mode
      );
      assert.notEqual(
        JSON.parse(
          readFileSync(join(f.env.KOED_HOME, "installer", "owner.json"))
        ).state,
        "installed"
      );
    } finally {
      cleanup(f);
    }
  }
});

test("refuses held locks, other versions and unowned koed commands", () => {
  const f = fixture();
  try {
    const env = trustedNode(f);
    mkdirSync(join(f.dir, ".local", "bin"), { recursive: true });
    writeFileSync(join(f.dir, ".local", "bin", "koed"), "theirs");
    const unowned = run(f.source, env);
    assert.notEqual(unowned.status, 0);
    assert.match(unowned.stderr, /existing koed command/);
    assert.equal(existsSync(f.env.KOED_HOME), false);
    assert.equal(
      readFileSync(join(f.dir, ".local", "bin", "koed"), "utf8"),
      "theirs"
    );
    rmSync(join(f.dir, ".local", "bin", "koed"));

    assert.equal(run(f.source, env).status, 0);
    rmSync(join(f.dir, "koed-calls"));
    const lock = join(f.env.KOED_HOME, "installer", "lock");
    mkdirSync(lock);
    const locked = run(f.source, env);
    assert.notEqual(locked.status, 0);
    assert.match(locked.stderr, /Another installer/);
    assert.equal(existsSync(lock), true, "foreign lock is never removed");
    assert.deepEqual(calls(f), []);
    rmSync(lock, { recursive: true });

    const other = run(f.source.replace("'1.2.3'", "'1.2.4'"), env, [
      "--version",
      "1.2.4"
    ]);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /does not own/);
    assert.deepEqual(calls(f), []);
  } finally {
    cleanup(f);
  }
});

test("rejects unsupported macOS and glibc versions before creating home", () => {
  for (const override of [
    { MACOS_VERSION: "13.6" },
    { HOST_OS: "Linux", HOST_ARCH: "x86_64", GLIBC_VERSION: "glibc 2.34" },
    { HOST_OS: "Linux", HOST_ARCH: "x86_64", GLIBC_VERSION: "musl 1.2" }
  ]) {
    const f = fixture();
    try {
      const result = run(f.source, { ...f.env, ...override });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsupported/i);
      assert.equal(existsSync(f.env.KOED_HOME), false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("refuses an existing unowned home without modifying it", () => {
  const f = fixture();
  try {
    mkdirSync(f.env.KOED_HOME);
    writeFileSync(join(f.env.KOED_HOME, "keep"), "untouched");
    const result = run(f.source, f.env);
    assert.notEqual(result.status, 0);
    assert.equal(
      readFileSync(join(f.env.KOED_HOME, "keep"), "utf8"),
      "untouched"
    );
    assert.equal(existsSync(join(f.env.KOED_HOME, "installer")), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

function fallbackFixture(f, unsafe = false, target = "darwin-arm64") {
  const archive = join(f.dir, "node.tar.xz");
  const py = `import io,tarfile,sys
root='node-v26.13.0-${target}/'
node=open(sys.argv[3],'rb').read()
with tarfile.open(sys.argv[1], 'w:xz') as t:
 for name,data in [(root+'bin/node',node),(root+'lib/node_modules/npm/bin/npm-cli.js',b'fixture')]+([('../escape',b'bad')] if sys.argv[2]=='bad' else []):
  info=tarfile.TarInfo(name); info.size=len(data); info.mode=0o755; t.addfile(info,io.BytesIO(data))
 if sys.argv[2]=='link':
  info=tarfile.TarInfo(root+'bin/evil'); info.type=tarfile.SYMTYPE; info.linkname='../lib'; t.addfile(info)
 if sys.argv[2]=='hardlink':
  info=tarfile.TarInfo(root+'bin/evil'); info.type=tarfile.LNKTYPE; info.linkname=root+'bin/node'; t.addfile(info)
 if sys.argv[2]=='duplicate':
  info=tarfile.TarInfo(root+'bin/node'); info.size=3; t.addfile(info,io.BytesIO(b'bad'))
 if sys.argv[2]=='oversized':
  info=tarfile.TarInfo(root+'huge'); info.size=268435457; t.fileobj.write(info.tobuf())`;
  writeFileSync(join(f.dir, "fake-node-source"), fakeNode);
  const made = spawnSync("python3", [
    "-c",
    py,
    archive,
    typeof unsafe === "string" ? unsafe : unsafe ? "bad" : "good",
    join(f.dir, "fake-node-source")
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const digest = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  writeFileSync(join(f.dir, "node"), "#!/bin/sh\necho v18.0.0\n", {
    mode: 0o755
  });
  writeFileSync(
    join(f.dir, "curl"),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then shift; out="$1"; fi; shift; done\n/bin/cp "$ARCHIVE" "$out"\n',
    { mode: 0o755 }
  );
  const source = f.source.replace(
    target === "linux-x64"
      ? "d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997"
      : "6f5b3187d9df9fc007e881167905bc7d69ad26450ddc377c83d63256a2495b6e",
    digest
  );
  return {
    source,
    env: { ...f.env, ARCHIVE: archive, KOED_INSTALL_POLL_SECONDS: "0" }
  };
}

const atomicHashes = {
  archive: "fbd4e154a6b444229ea002cc209df099209c0adc09102e5fd21239a3d2b55e2d",
  library: "107ab9f7661a1c47cddfb5cd1def99ec537a50a9a537fbe38cdde1b34b8ba280",
  copyright: "da8191658b3452ce9caf31638ba61dab31a38c619fa39df119812e050f592fd3",
  license: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"
};

test("compatible Operator-provided Linux Node is reused without downloading private libraries", () => {
  const f = fixture();
  try {
    const env = { ...trustedNode(f), HOST_OS: "Linux", HOST_ARCH: "x86_64" };
    writeFileSync(
      join(f.dir, "curl"),
      '#!/bin/sh\necho attempted > "$HOME/download-attempt"\nexit 99\n',
      { mode: 0o755 }
    );
    const result = run(f.source, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.env.KOED_HOME, "installer/node")), false);
    assert.equal(existsSync(join(f.dir, "download-attempt")), false);
    assert.equal(
      readFileSync(join(f.dir, "trusted/bin/node"), "utf8"),
      fakeNode
    );
  } finally {
    cleanup(f);
  }
});

function linuxFallbackFixture(f, mode = "good") {
  const sample = fallbackFixture(f, false, "linux-x64");
  const archive = join(f.dir, "libatomic.deb");
  const library = "fixture libatomic";
  const made = spawnSync("python3", [
    "-c",
    `import io,lzma,tarfile,sys
out,mode,library=sys.argv[1:]
data=io.BytesIO()
with tarfile.open(fileobj=data,mode='w') as t:
 m=tarfile.TarInfo('./usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0')
 m.size=len(library)
 if mode=='symlink': m.type=tarfile.SYMTYPE; m.linkname='/outside'
 if mode=='missing': m.name='./not-libatomic'
 t.addfile(m,io.BytesIO(library.encode()) if m.isfile() else None)
 if mode=='duplicate': t.addfile(m,io.BytesIO(library.encode()))
payload=lzma.compress(b'x'*1048577 if mode=='oversized' else data.getvalue())
def member(name,b):
 header=f'{name:<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(b):<10}'
 return header.encode()+b'\x60\\n'+b+(b'\\n' if len(b)%2 else b'')
deb=b'!<arch>\\n'+member('debian-binary',b'2.0\\n')+member('data.tar.xz',payload)
open(out,'wb').write(b'invalid ar' if mode=='malformed' else deb)`,
    archive,
    mode,
    library
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  const copyright = join(f.dir, "copyright");
  const license = join(f.dir, "COPYING3");
  writeFileSync(copyright, "fixture copyright and runtime exception");
  writeFileSync(license, "fixture GPL");
  const values = {
    archive: readFileSync(archive),
    library: Buffer.from(library),
    copyright: readFileSync(copyright),
    license: readFileSync(license)
  };
  let source = sample.source;
  for (const [key, bytes] of Object.entries(values))
    source = source.replace(
      atomicHashes[key],
      createHash("sha256").update(bytes).digest("hex")
    );
  const curl = `#!/bin/sh
while [ $# -gt 0 ]; do
 if [ "$1" = -o ]; then shift; out="$1"; else url="$1"; fi
 shift
done
case "$url" in
 *nodejs.org*) from="$ARCHIVE" ;;
 *libatomic1*) from="$ATOMIC_ARCHIVE" ;;
 *_copyright) from="$ATOMIC_COPYRIGHT" ;;
 *gpl-3.0.txt) from="$ATOMIC_LICENSE" ;;
 *) exit 65 ;;
esac
/bin/cp "$from" "$out"
`;
  writeFileSync(join(f.dir, "curl"), curl, { mode: 0o755 });
  return {
    source,
    curl,
    env: {
      ...sample.env,
      HOST_OS: "Linux",
      HOST_ARCH: "x86_64",
      ATOMIC_ARCHIVE: archive,
      ATOMIC_COPYRIGHT: copyright,
      ATOMIC_LICENSE: license,
      LD_LIBRARY_PATH: "/untrusted/inherited/path"
    }
  };
}

test("Linux private Node bundles authenticated libatomic, preserves licenses and works after installer exit", () => {
  const f = fixture();
  try {
    const sample = linuxFallbackFixture(f);
    const result = run(sample.source, sample.env);
    assert.equal(result.status, 0, result.stderr);
    const installer = join(realpathSync(f.env.KOED_HOME), "installer");
    const root = join(installer, "node/node-v26.13.0-linux-x64");
    assert.equal(
      readFileSync(join(root, "lib/koed/libatomic.so.1"), "utf8"),
      "fixture libatomic"
    );
    assert.match(
      readFileSync(join(root, "lib/koed/copyright"), "utf8"),
      /runtime exception/
    );
    assert.equal(
      readFileSync(join(root, "lib/koed/COPYING3"), "utf8"),
      "fixture GPL"
    );
    assert.match(
      readFileSync(join(f.dir, "koed-environment"), "utf8"),
      new RegExp(`LD_LIBRARY_PATH=${root}/lib/koed\\n`)
    );
    const launcher = join(installer, "bin/koed");
    const later = spawnSync(launcher, ["doctor", "--json"], {
      env: { HOME: f.dir, PATH: "/usr/bin:/bin" },
      encoding: "utf8"
    });
    assert.equal(later.status, 0, later.stderr);
    assert.match(
      readFileSync(join(f.dir, "koed-environment"), "utf8"),
      new RegExp(`LD_LIBRARY_PATH=${root}/lib/koed\\n`)
    );
    const before = readFileSync(
      join(f.env.KOED_HOME, "run/koed-server.lock"),
      "utf8"
    );
    writeFileSync(join(f.dir, "curl"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const rerun = run(sample.source, sample.env);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(
      readFileSync(join(f.env.KOED_HOME, "run/koed-server.lock"), "utf8"),
      before
    );
    // Do not execute the old wrapper before checking/repairing private bytes.
    writeFileSync(join(root, "lib/koed/libatomic.so.1"), "damaged library");
    writeFileSync(
      join(root, "bin/node"),
      `#!/bin/sh\necho attempted > "${f.dir}/private-probe"\nexit 99\n`,
      { mode: 0o755 }
    );
    writeFileSync(join(f.dir, "curl"), sample.curl, { mode: 0o755 });
    const repaired = run(sample.source, sample.env);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(existsSync(join(f.dir, "private-probe")), false);
    assert.equal(
      readFileSync(join(root, "lib/koed/libatomic.so.1"), "utf8"),
      "fixture libatomic"
    );
    // Recover a missing library and an interrupted binary-to-wrapper rename.
    rmSync(join(root, "lib/koed/libatomic.so.1"));
    rmSync(join(root, "bin/node"));
    writeFileSync(join(f.dir, "curl"), sample.curl, { mode: 0o755 });
    const recovered = run(sample.source, sample.env);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(join(root, "lib/koed/libatomic.so.1")), true);
  } finally {
    cleanup(f);
  }
});

test("Linux private Node rejects unpinned libraries and notices before activating the wrapper", () => {
  for (const key of ["archive", "library", "copyright", "license"]) {
    const f = fixture();
    try {
      const sample = linuxFallbackFixture(f);
      const source = sample.source.replace(
        createHash("sha256")
          .update(
            key === "archive"
              ? readFileSync(sample.env.ATOMIC_ARCHIVE)
              : key === "library"
                ? Buffer.from("fixture libatomic")
                : readFileSync(
                    key === "copyright"
                      ? sample.env.ATOMIC_COPYRIGHT
                      : sample.env.ATOMIC_LICENSE
                  )
          )
          .digest("hex"),
        atomicHashes[key]
      );
      const result = run(source, sample.env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /checksum/i);
      assert.equal(
        existsSync(
          join(
            f.env.KOED_HOME,
            "installer/node/node-v26.13.0-linux-x64/bin/node.bin"
          )
        ),
        false
      );
      assert.equal(calls(f).length, 0);
    } finally {
      cleanup(f);
    }
  }
});

test("Linux private Node rejects malformed, linked, duplicate, missing and oversized library payloads", () => {
  for (const mode of [
    "malformed",
    "symlink",
    "duplicate",
    "missing",
    "oversized"
  ]) {
    const f = fixture();
    try {
      const sample = linuxFallbackFixture(f, mode);
      const result = run(sample.source, sample.env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe private Node library/i);
      assert.equal(calls(f).length, 0);
    } finally {
      cleanup(f);
    }
  }
});

test("private Node fallback verifies pinned bytes and stages exact package", () => {
  const f = fixture();
  try {
    const sample = fallbackFixture(f);
    const result = run(sample.source, sample.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      JSON.parse(
        readFileSync(join(f.env.KOED_HOME, "installer/owner.json"), "utf8")
      ).node,
      /installer\/node\/node-v26\.13\.0-darwin-arm64\/bin\/node$/
    );
    assert.equal(calls(f).at(-1), "doctor --json");
    assert.equal(
      JSON.parse(
        readFileSync(
          join(
            f.env.KOED_HOME,
            "installer/package/node_modules/@koed-labs/server/package.json"
          ),
          "utf8"
        )
      ).version,
      "1.2.3"
    );
  } finally {
    cleanup(f);
  }
});

test("private Node fallback rejects unpinned bytes and traversal archives", () => {
  for (const unsafe of [
    false,
    true,
    "link",
    "hardlink",
    "duplicate",
    "oversized"
  ]) {
    const f = fixture();
    try {
      const sample = fallbackFixture(f, unsafe);
      const result = run(unsafe ? sample.source : f.source, sample.env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, unsafe ? /unsafe|archive/i : /checksum/i);
      assert.equal(existsSync(join(f.dir, "escape")), false);
      assert.equal(
        existsSync(
          join(
            f.env.KOED_HOME,
            "installer/package/node_modules/@koed-labs/server/package.json"
          )
        ),
        false
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("does not reuse Node reporting a malformed version", () => {
  const f = fixture();
  try {
    const bin = join(f.dir, "trusted", "bin");
    const npm = join(f.dir, "trusted", "lib", "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(npm, { recursive: true });
    writeFileSync(join(npm, "npm-cli.js"), "fixture");
    writeFileSync(
      join(bin, "node"),
      '#!/bin/sh\nif [ "$1" = --version ]; then echo v26.bad; else echo 11.0.0; fi\n',
      { mode: 0o755 }
    );
    writeFileSync(
      join(f.dir, "curl"),
      '#!/bin/sh\necho attempted > "$HOME/download-attempt"\nexit 1\n',
      { mode: 0o755 }
    );
    const result = run(f.source, {
      ...f.env,
      PATH: `${f.dir}:${bin}:/usr/bin:/bin`
    });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(f.dir, "download-attempt")), true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
