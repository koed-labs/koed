# ADR 0062: Packaged Privacy CPU inference worker

Status: accepted for the Linux x64 candidate, 26 October 2026. Production
qualification and deployment remain separate gates in `tickets.md`.

## Context

The pinned Privacy classifier runs behind an authenticated TypeScript service.
The 23 October synthetic experiments found materially faster CPU execution with
official Python ONNX Runtime 1.31.0, preserving decoded outputs on the retained
reference cases. The supported npm binding does not provide that engine version;
replacing a native library underneath an older binding fails its versioned ABI.
The migration must preserve TypeScript tokenization, complete windows, offsets,
calibration, decoding, masking, source bindings and Team authorization.

## Decision

Package CPython 3.11.14 and official ONNX Runtime 1.31.0 with NumPy 2.2.6 inside
the Linux x64 CPU image. Pin both base images by digest and all Python wheels by
version and SHA-256. Keep installed license notices and a build-time dependency
identity, including installed-file hashes. Users do not install Python manually.
The existing general image and native/accelerator packaging keep their supported
Transformers execution path.

The existing runtime adapter delegates only window tensor execution to a local
child process. Versioned, length-bounded stdio frames carry a process generation
and unique job identity. The child receives token tensors and returns finite,
shape-validated logits. It has a minimal environment, no inherited service,
database or publication credentials, no listening endpoint and no download code.
The service verifies all pinned model files before starting it. It retains the
existing startup masking validation and classification/control authentication.
Runtime validation identity includes worker code, wheel lock and packaged binary
identity, independently of the unchanged pinned classifier hash.

## Trade-off

A second interpreter and explicit IPC supervision add packaging and lifecycle
work. They allow use of an upstream-supported, already measured engine without
ABI patching or making a future Node binding a prerequisite. The interface keeps
that choice local to model execution. A matching supported Node engine may later
replace the child through the same boundary after equivalent qualification.
Linux CPU qualification does not imply native or accelerator qualification.

The initial slice retains one admitted request and one four-thread worker.
Recovery, two-worker scheduling and short-field batching have independent ticket
gates. No publication authority, finalization concurrency or classifier artifact
changes are part of this decision.
