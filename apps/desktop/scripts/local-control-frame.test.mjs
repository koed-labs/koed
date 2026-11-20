import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const native = resolve(root, "apps/desktop/src/background-agent/native");

test(
  "native framing handles fragmented input and rejects invalid bounds",
  { skip: process.platform !== "darwin" },
  () => {
    const scratch = resolve(root, "scratch");
    mkdirSync(scratch, { recursive: true });
    const temp = mkdtempSync(resolve(scratch, "control-frame-test-"));
    try {
      const source = resolve(temp, "test.cc");
      const executable = resolve(temp, "test-frame");
      writeFileSync(
        source,
        String.raw`
#include "control-frame.h"
#include <vector>
#include <string>
int main() {
  std::vector<std::string> frames;
  koed::ControlFrameDecoder split;
  uint8_t first[] = {0,0,0}, second[] = {3,'a'}, third[] = {'b','c',0,0,0,1,'x'};
  if (!split.feed(first, sizeof(first), &frames) || !frames.empty()) return 1;
  if (!split.feed(second, sizeof(second), &frames) || !frames.empty()) return 2;
  if (!split.feed(third, sizeof(third), &frames) || frames.size()!=2 || frames[0]!="abc" || frames[1]!="x") return 3;
  koed::ControlFrameDecoder empty;
  uint8_t zero[] = {0,0,0,0}; frames.clear();
  if (empty.feed(zero, sizeof(zero), &frames) || empty.feed(first, sizeof(first), &frames)) return 4;
  koed::ControlFrameDecoder large;
  uint8_t tooLarge[] = {0,1,0,1};
  if (large.feed(tooLarge, sizeof(tooLarge), &frames)) return 5;
  koed::ControlFrameDecoder max; std::vector<uint8_t> maximum = {0,1,0,0};
  maximum.resize(4 + 65536, 'z'); frames.clear();
  if (!max.feed(maximum.data(), maximum.size(), &frames) || frames.size()!=1 || frames[0].size()!=65536) return 7;
  frames.clear();
  koed::ControlFrameDecoder many; std::vector<uint8_t> data;
  for (int i=0; i<65; ++i) data.insert(data.end(), {0,0,0,1,'x'});
  if (many.feed(data.data(), data.size(), &frames)) return 6;
  koed::ControlFrameDecoder reuse; frames.clear();
  data.resize(64*5);
  if (!reuse.feed(data.data(), data.size(), &frames) || frames.size()!=64) return 8;
  uint8_t one[] = {0,0,0,1,'x'};
  if (!reuse.feed(one, sizeof(one), &frames) || frames.size()!=65) return 9;
  koed::ControlFrameDecoder partial; frames.resize(64);
  uint8_t head[] = {0,0,0,1};
  if (!partial.feed(head, sizeof(head), &frames)) return 10;
  uint8_t body[] = {'a'};
  if (!partial.feed(body, sizeof(body), &frames) || frames.size()!=65) return 11;
  return 0;
}`
      );
      execFileSync("/usr/bin/clang++", [
        "-std=c++17",
        "-I",
        native,
        source,
        resolve(native, "control-frame.cc"),
        "-o",
        executable
      ]);
      assert.doesNotThrow(() => execFileSync(executable));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
);
