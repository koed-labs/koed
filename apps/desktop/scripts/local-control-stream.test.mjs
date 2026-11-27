import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const native = resolve(root, "apps/desktop/src/background-agent/native");

test("framed nonblocking streams bound queues and deliver UTF-8 frames", () => {
  const scratch = resolve(root, "scratch");
  mkdirSync(scratch, { recursive: true });
  const temp = mkdtempSync(resolve(scratch, "control-stream-"));
  const source = resolve(temp, "test.cc");
  const executable = resolve(temp, "test");
  try {
    writeFileSync(
      source,
      String.raw`
#include "control-stream.h"
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>
#include <string>
#include <vector>
int main() {
  int fd[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, fd)) return 1;
  for (int n : fd) if (fcntl(n, F_SETFL, fcntl(n, F_GETFL) | O_NONBLOCK)) return 2;
  koed::ControlStream outgoing(fd[0]);
  koed::ControlStream incoming(fd[1]);
  if (!outgoing.ready() || !incoming.ready()) return 11;
  if (!outgoing.queue("{\"value\":\"café\"}")) return 3;
  if (!outgoing.flush()) return 4;
  std::vector<std::string> frames;
  if (incoming.readAvailable(&frames) != koed::ControlReadResult::Open || frames.size() != 1 || frames[0] != "{\"value\":\"café\"}") return 5;
  if (outgoing.queue("") || outgoing.queue(std::string(65537, 'x'))) return 6;
  for (int i = 0; i < 64; ++i) if (!outgoing.queue("{}")) return 7;
  if (outgoing.queue("{}")) return 8;
  if (!outgoing.flush()) return 9;
  frames.clear();
  if (incoming.readAvailable(&frames) != koed::ControlReadResult::MoreAvailable || frames.size() != 64) return 10;
  std::string burst;
  for (int i = 0; i < 65; ++i) burst.append("\0\0\0\2{}", 6);
  if (write(fd[0], burst.data(), burst.size()) != static_cast<ssize_t>(burst.size())) return 20;
  frames.clear();
  if (incoming.readAvailable(&frames) != koed::ControlReadResult::MoreAvailable || frames.size() != 64) return 21;
  frames.clear();
  if (incoming.readAvailable(&frames) != koed::ControlReadResult::Open || frames.size() != 1) return 22;
  if (!outgoing.queue("{}") || !outgoing.flush()) return 12;
  if (shutdown(fd[0], SHUT_WR)) return 13;
  frames.clear();
  if (incoming.readAvailable(&frames) != koed::ControlReadResult::CleanEof || frames.size() != 1) return 14;
  close(fd[0]); close(fd[1]);
  int more[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, more)) return 15;
  koed::ControlStream blocking(more[0]);
  if (blocking.ready()) return 16;
  if (fcntl(more[0], F_SETFL, fcntl(more[0], F_GETFL) | O_NONBLOCK)) return 17;
  koed::ControlStream truncated(more[0]);
  const char part[] = {0, 0, 0};
  if (write(more[1], part, sizeof(part)) != sizeof(part) || shutdown(more[1], SHUT_WR)) return 18;
  frames.clear();
  if (truncated.readAvailable(&frames) != koed::ControlReadResult::TruncatedEof) return 19;
  close(more[0]); close(more[1]);
  int partial[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, partial)) return 27;
  for (int n : partial) if (fcntl(n, F_SETFL, fcntl(n, F_GETFL) | O_NONBLOCK)) return 28;
  int smallBuffer = 1024;
  if (setsockopt(partial[0], SOL_SOCKET, SO_SNDBUF, &smallBuffer, sizeof(smallBuffer))) return 29;
  koed::ControlStream sender(partial[0]), receiver(partial[1]);
  const std::string big(65536, 'x');
  if (!sender.queue(big) || !sender.flush() || !sender.hasPendingWrites()) return 30;
  frames.clear();
  for (int i = 0; i < 10000 && (sender.hasPendingWrites() || frames.empty()); ++i) {
    if (receiver.readAvailable(&frames) != koed::ControlReadResult::Open || !sender.flush()) return 31;
  }
  if (sender.hasPendingWrites() || frames.size() != 1 || frames[0] != big) return 32;
  close(partial[0]); close(partial[1]);
  int closed[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, closed)) return 23;
  if (fcntl(closed[0], F_SETFL, fcntl(closed[0], F_GETFL) | O_NONBLOCK)) return 24;
  koed::ControlStream noSignal(closed[0]);
  if (!noSignal.ready() || !noSignal.queue("{}")) return 25;
  close(closed[1]);
  if (noSignal.flush()) return 26;
  close(closed[0]);
  return 0;
}`
    );
    execFileSync("/usr/bin/clang++", [
      "-std=c++17",
      "-I",
      native,
      source,
      resolve(native, "control-stream.cc"),
      resolve(native, "control-frame.cc"),
      "-o",
      executable
    ]);
    execFileSync(executable);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
