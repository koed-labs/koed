import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

export const readFixture = () => {
  const filename = process.env.KOED_DELIVERY_FIXTURE_PATH;
  if (!filename) throw new Error("Memory delivery fixture path is required");
  return JSON.parse(readFileSync(filename, "utf8"));
};
export const recordEvent = (fixture, kind, fields = {}) => {
  // Only fixture-generated, decision-sized fields are recorded. Never copy
  // native tool results, receipt nonces, authorization, or client payloads.
  appendFileSync(
    fixture.eventsPath,
    `${JSON.stringify({ kind, at: Date.now(), ...fields })}\n`,
    { mode: 0o600 }
  );
};
