import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { cosineSimilarity } from "../../../scripts/embedding-acceleration-benchmark-lib.mjs";
import { seedAccelerationStorageProbe } from "./acceleration-storage-smoke.mjs";

// Called only by the isolated packaged smoke. Credentials remain in this parent
// process and authenticate synthetic inputs to the temporary local service.
export async function smokePackagedAcceleration(
  desktop,
  koedHome,
  fetcher = globalThis.fetch
) {
  const before = await desktop.invoke("acceleration_status");
  assert.equal(before.snapshot.readOnlyReason, null);
  assert.ok(
    before.snapshot.hardware.backend,
    "An eligible installed GPU backend is required for acceleration qualification"
  );
  const model = before.snapshot.model;
  const embedding = async () => {
    const ports = JSON.parse(
      readFileSync(resolve(koedHome, "config/local-ports.json"), "utf8")
    );
    const secrets = JSON.parse(
      readFileSync(
        resolve(koedHome, "config/local-service-secrets.json"),
        "utf8"
      )
    );
    assert.match(ports.embedding, /^\d+$/);
    const response = await fetcher(
      `http://127.0.0.1:${ports.embedding}/embed`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-koed-embedding-token": secrets.EMBEDDING_SERVICE_TOKEN
        },
        body: JSON.stringify({
          texts: [
            "Synthetic packaged acceleration check: the blue notebook contains a reminder to water the plant."
          ]
        }),
        signal: globalThis.AbortSignal.timeout(60_000)
      }
    );
    assert.equal(response.ok, true, "Synthetic embedding succeeded");
    const body = await response.json();
    assert.ok(
      Array.isArray(body.vectors?.[0]) && body.vectors[0].every(Number.isFinite)
    );
    const healthResponse = await fetcher(
      `http://127.0.0.1:${ports.embedding}/health`,
      {
        headers: { "x-koed-embedding-token": secrets.EMBEDDING_SERVICE_TOKEN },
        signal: globalThis.AbortSignal.timeout(5_000)
      }
    );
    assert.equal(healthResponse.ok, true);
    const health = await healthResponse.json();
    assert.equal(health.authValid, true);
    assert.match(health.artifactHash, /^[a-f0-9]{64}$/);
    return {
      vector: body.vectors[0],
      modelKey: health.modelKey,
      artifactHash: health.artifactHash,
      semanticIdentity: {
        modelKey: health.modelKey,
        dimensions: health.dimensions,
        normalized: health.normalized,
        artifactHash: health.artifactHash,
        artifactRevision: health.artifactRevision,
        tokenizer: health.tokenizer,
        tokenizerRevision: health.tokenizerRevision
      }
    };
  };
  const set = async (preference) => {
    const started = await desktop.invoke(`acceleration_${preference}`);
    const deadline = Date.now() + 180_000;
    let current = started;
    while (current.operation?.state === "running") {
      assert.ok(
        Date.now() < deadline,
        "Processing change finished within the smoke deadline"
      );
      await delay(250);
      current = await desktop.invoke("acceleration_status");
      assert.equal(current.operation.id, started.operation.id);
    }
    assert.equal(
      current.operation.state,
      "complete",
      current.operation.message
    );
    assert.deepEqual(current.snapshot.model, model);
    assert.equal(current.snapshot.preference, preference);
    assert.equal(
      current.snapshot.embedding.state,
      "ready",
      `Verified embedding backend: ${JSON.stringify(current.snapshot.embedding)} (${current.operation.message})`
    );
    return current.snapshot;
  };
  const cpu = await set("cpu");
  assert.equal(cpu.embedding.backend, "cpu");
  const cpuVector = await embedding();
  const verifyStorage = await seedAccelerationStorageProbe(koedHome, cpuVector);
  const auto = await set("auto");
  const expected = before.snapshot.hardware.backend;
  assert.equal(
    auto.embedding.backend,
    expected,
    "Eligible packaged GPU is active"
  );
  const gpuVector = await embedding();
  assert.equal(gpuVector.vector.length, cpuVector.vector.length);
  assert.equal(gpuVector.artifactHash, cpuVector.artifactHash);
  assert.equal(gpuVector.modelKey, cpuVector.modelKey);
  assert.deepEqual(gpuVector.semanticIdentity, cpuVector.semanticIdentity);
  const storage = await verifyStorage();
  const agreement = cosineSimilarity(cpuVector.vector, gpuVector.vector);
  assert.ok(agreement >= 0.99, "CPU/GPU embeddings agree");
  assert.equal(auto.privacy.state, before.snapshot.privacy.state);
  return {
    backend: expected,
    model: model.key,
    dimensions: cpuVector.vector.length,
    modelArtifactHash: cpuVector.artifactHash,
    cosineAgreement: agreement,
    semanticIdentity: gpuVector.semanticIdentity,
    storage,
    savedPreference: auto.preference,
    privacy: auto.privacy
  };
}
