import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const native = resolve(root, "apps/desktop/src/background-agent/native");

test(
  "native socket owns descriptors, rejects replacement and authenticates before dispatch",
  { skip: process.platform !== "darwin" },
  () => {
    const scratch = resolve(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    const temp = mkdtempSync(resolve(scratch, "control-socket-"));
    const source = resolve(temp, "test.mm");
    const executable = resolve(temp, "test");
    try {
      writeFileSync(
        source,
        String.raw`
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include "control-socket.h"
#include <poll.h>
#include <unistd.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <string>
#include <type_traits>
static_assert(!std::is_copy_constructible_v<koed::ControlListener>);
static_assert(!std::is_copy_assignable_v<koed::ControlListener>);
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  std::string path(argv[1]);
  koed::ControlListener listener;
  if (!koed::openControlListener(path, &listener)) return 2;
  koed::ControlListener duplicate;
  if (koed::openControlListener(path, &duplicate)) return 3;
  struct stat st{}; if (lstat(path.c_str(), &st) || (st.st_mode & 0777) != 0600) return 4;
  int client = koed::connectControlSocket(path);
  if (client < 0) return 5;
  pollfd waitListener{listener.fd, POLLIN, 0};
  if (poll(&waitListener, 1, 5000) != 1) return 6;
  SecRequirementRef allow = nullptr;
  if (SecRequirementCreateWithString(CFSTR("true"), kSecCSDefaultFlags, &allow) != errSecSuccess) return 7;
  koed::ControlPeer peer{};
  int accepted = koed::acceptControlSocket(listener.fd, allow, &peer);
  if (accepted < 0 || peer.pid != getpid() || peer.uid != geteuid()) return 8;
  koed::ControlPeer serverPeer{};
  if (!koed::authenticateConnectedControlSocket(client, allow, &serverPeer) || serverPeer.pid != getpid()) return 12;
  SecRequirementRef deny = nullptr;
  if (SecRequirementCreateWithString(CFSTR("identifier \"foreign.example\""), kSecCSDefaultFlags, &deny) != errSecSuccess) return 13;
  if (koed::authenticateConnectedControlSocket(client, deny, &serverPeer)) return 14;
  close(accepted); close(client); CFRelease(allow); CFRelease(deny);
  std::string moved = path + ".old";
  if (rename(path.c_str(), moved.c_str())) return 9;
  int replacement = open(path.c_str(), O_CREAT | O_EXCL | O_WRONLY, 0600);
  if (replacement < 0) return 10;
  close(replacement);
  koed::closeControlListener(&listener);
  if (lstat(path.c_str(), &st) || !S_ISREG(st.st_mode)) return 11;
  unlink(path.c_str()); unlink(moved.c_str());
  return 0;
}`
      );
      execFileSync("/usr/bin/clang++", [
        "-std=c++17",
        "-fobjc-arc",
        "-I",
        native,
        source,
        resolve(native, "local-control.mm"),
        resolve(native, "control-socket.mm"),
        "-framework",
        "Foundation",
        "-framework",
        "Security",
        "-lbsm",
        "-o",
        executable
      ]);
      execFileSync("/usr/bin/codesign", [
        "--force",
        "--sign",
        "-",
        "--identifier",
        "ai.koed.test.socket",
        executable
      ]);
      execFileSync(executable, [resolve(temp, "socket")]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
);
