# Security Policy

## Supported Versions

Koed Self-Hosted is currently pre-1.0. Until versioned releases are published,
security fixes are made on the default branch and are intended for the latest
available source.

Operators should run the latest published commit or release candidate available
for the self-hosted distribution. Older commits, forks, and locally modified
deployments are not supported unless a maintainer explicitly says otherwise.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately by emailing
security@koed.ai.

Do not open a public GitHub issue, public pull request, public discussion, or
public chat thread for an unpatched vulnerability.

Include as much of the following as you can:

- affected Koed Self-Hosted commit, branch, or release;
- affected service or package;
- steps to reproduce;
- impact and whether authentication is required;
- any relevant logs, screenshots, or proof-of-concept details.

Please keep proof-of-concept material minimal. Do not include real API Tokens,
session cookies, database credentials, private deployment secrets, captured
Memory content, database exports, backups, or user-identifying data unless a
maintainer explicitly requests a secure transfer path.

## Memory Data Disclosure

Koed Self-Hosted can store sensitive Memory data from AI-client Conversations,
including prompts, tool output, LCM source evidence, LCM summaries, graph text,
and diagnostic metadata. Treat this data as private user data.

When reporting security issues:

- do not disclose captured Memory data publicly;
- do not attach raw database dumps or backups to public reports;
- redact API Tokens, bearer tokens, cookies, local paths, and deployment
  secrets;
- use synthetic or minimized examples whenever possible.

## Scope

Security reports are in scope when they affect the Koed Self-Hosted repository,
including:

- authentication or session handling;
- API Token handling;
- authorization boundaries for Personal Memory and Team Memory;
- capture policy enforcement;
- exposure of Memory data, diagnostics, logs, backups, or exports;
- container, deployment, or default-configuration issues that could expose
  Koed services unexpectedly.

Issues in third-party services, private deployments, or modified forks may be
out of scope unless they demonstrate a problem in Koed Self-Hosted itself.

## Operator Responsibilities

Koed Self-Hosted assumes the Operator controls the deployment. Operators are
responsible for keeping Postgres, Redis, the embedding service, and Koed API
services off public networks unless deliberately protected by TLS, firewalling,
authentication, and reverse-proxy controls.

Captured Memory data is stored plaintext at the application layer in Postgres in
this self-hosted build. Protect database volumes, backups, exports, and
administrator access accordingly.
