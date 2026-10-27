import assert from "node:assert/strict";

const coreChecks = [
  "api",
  "database",
  "workerQueues",
  "embeddingService",
  "privacyService",
  "localAiRuntime",
  "apiToken",
  "mcpServer",
  "deviceIdentity"
];

const verifyCoreDoctor = (doctor, phase) => {
  for (const id of coreChecks)
    assert.equal(
      doctor.checks.find((check) => check.id === id)?.state,
      "healthy",
      `${phase}: doctor ${id}`
    );
};

export async function verifyHeadlessLifecycle({
  command,
  waitForHealthy,
  waitForStopped,
  recordDoctor
}) {
  const cycles = [];
  for (const phase of ["initial", "restart"]) {
    let started;
    try {
      started = JSON.parse(command(["start", "--daemon", "--json"]));
      assert.equal(started.ok, true, `${phase}: start failed`);
      assert.ok(
        Number.isSafeInteger(started.startedPid) && started.startedPid > 0,
        `${phase}: missing supervisor PID`
      );
      if (cycles.length > 0)
        assert.notEqual(
          started.startedPid,
          cycles[0].startedPid,
          "restart reused the previous supervisor"
        );
      const runtime = await waitForHealthy();
      assert.equal(
        runtime.pid,
        started.startedPid,
        `${phase}: healthy supervisor PID`
      );
      const doctor = JSON.parse(command(["doctor", "--json"]));
      recordDoctor(phase, doctor);
      verifyCoreDoctor(doctor, phase);
    } finally {
      const stopped = JSON.parse(command(["stop", "--json"]));
      assert.equal(stopped.ok, true, `${phase}: stop failed`);
      if (started?.startedPid)
        assert.equal(
          await waitForStopped(started.startedPid),
          true,
          `${phase}: supervisor did not exit`
        );
    }
    cycles.push({ phase, startedPid: started.startedPid });
  }
  return cycles;
}
