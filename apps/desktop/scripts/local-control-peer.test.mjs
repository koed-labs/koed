import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const native = resolve(root, "apps/desktop/src/background-agent/native");

test("production signing policy requires Developer ID Application", () => {
  const source = readFileSync(resolve(native, "local-control.mm"), "utf8");
  assert.match(source, /1\.2\.840\.113635\.100\.6\.1\.13/u);
  assert.match(source, /1\.2\.840\.113635\.100\.6\.2\.6/u);
});

test(
  "peer validation checks the connecting process identity",
  { skip: process.platform !== "darwin" },
  () => {
    const scratch = resolve(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    const temp = mkdtempSync(resolve(scratch, "control-peer-test-"));
    try {
      const source = resolve(temp, "test.mm");
      const server = resolve(temp, "test-server");
      const client = resolve(temp, "test-client");
      const socket = resolve(temp, "peer.sock");
      writeFileSync(
        source,
        String.raw`
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include "local-control.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <cstring>
int main(int argc, char **argv) {
  if (argc != 3) return 1;
  sockaddr_un address{}; address.sun_family = AF_UNIX;
  if (std::strlen(argv[2]) >= sizeof(address.sun_path)) return 2;
  std::strcpy(address.sun_path, argv[2]);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return 3;
  if (std::strcmp(argv[1], "client") == 0) {
    if (connect(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) return 4;
    char byte; read(fd, &byte, 1); close(fd); return 0;
  }
  if (bind(fd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 || listen(fd, 1) != 0) return 5;
  pid_t child = fork();
  if (child == 0) { execl(argv[1], argv[1], "client", argv[2], nullptr); _exit(127); }
  if (child < 0) return 6;
  int peerFd = accept(fd, nullptr, nullptr);
  if (peerFd < 0) return 7;
  SecRequirementRef allow = nullptr, deny = nullptr;
  if (SecRequirementCreateWithString(CFSTR("identifier \"ai.koed.test.peer\""), kSecCSDefaultFlags, &allow) != errSecSuccess ||
      SecRequirementCreateWithString(CFSTR("identifier \"ai.koed.test.server\""), kSecCSDefaultFlags, &deny) != errSecSuccess) return 8;
  koed::ControlPeer peer{};
  bool accepted = koed::verifyControlPeer(peerFd, allow, &peer);
  bool rejected = !koed::verifyControlPeer(peerFd, deny, &peer);
  bool invalid = !koed::verifyControlPeer(-1, allow, &peer) && !koed::verifyControlPeer(peerFd, nullptr, &peer);
  SecRequirementRef production = koed::createProductionControlPeerRequirement();
  if (!production) return 10;
  CFRelease(production);
  bool productionRejectsAdhoc = !koed::verifyProductionControlPeer(peerFd, &peer);
  bool same = peer.pid == child && peer.pid != getpid() && peer.uid == geteuid();
  CFRelease(allow); CFRelease(deny); close(peerFd); close(fd); unlink(argv[2]);
  int status; waitpid(child, &status, 0);
  return accepted && rejected && invalid && productionRejectsAdhoc && same && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 9;
}`
      );
      execFileSync("/usr/bin/clang++", [
        "-std=c++17",
        "-fobjc-arc",
        "-DKOED_SIGNING_TEAM_ID=ABCDEFGHIJ",
        "-I",
        native,
        source,
        resolve(native, "local-control.mm"),
        "-framework",
        "Foundation",
        "-framework",
        "Security",
        "-lbsm",
        "-o",
        server
      ]);
      copyFileSync(server, client);
      execFileSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          "-",
          "--identifier",
          "ai.koed.test.server",
          server
        ],
        { stdio: "pipe" }
      );
      execFileSync(
        "/usr/bin/codesign",
        ["--force", "--sign", "-", "--identifier", "ai.koed.test.peer", client],
        { stdio: "pipe" }
      );
      assert.doesNotThrow(() =>
        execFileSync(server, [client, socket], { timeout: 10000 })
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
);
