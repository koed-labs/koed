# WorkOS Agent Registration Prototype

This local-only experiment tests whether WorkOS Agent Registration can feed
Koed's existing delegated authorisation and remote MCP routes. It is not enabled
in the normal API server, changes no production authentication, and contains no
real Memory. It does not replace WorkOS configuration or implement a second
memory, capture, task or synthesis pipeline.

## Cost Boundary

- Fixture mode makes **zero WorkOS network calls** and requires no credentials.
- Live mode is **staging only** and requires explicit Operator confirmation.
  It reads public instructions, validates credentials, and inspects registrations.
  The prototype never changes dashboard configuration or enables products.
- Use the default `*.authkit.app` domain. Custom domains are not needed.
- Do not enable paid SSO, Directory Sync, Audit Logs retention/streaming or other
  add-ons for this experiment.
- Outbound WorkOS calls are limited to 40 per staging process, with five-second
  timeouts and no automatic retries. Restarting resets this local safety limit;
  it is not a WorkOS billing quota or an account-wide spending cap.

WorkOS states that staging products can be tested at no cost, and AuthKit has a
free user allowance. Its public pricing page does not separately establish the
production price of Agent Registration. **Free staging testing is not proof of
free production availability.** Confirm production entitlement and pricing
before choosing a deployable design. A confirmation environment variable cannot
prove that an Operator supplied a staging API key.

Sources checked on 2026-10-15:
[pricing](https://workos.com/pricing),
[Agent Registration](https://workos.com/docs/authkit/agent-registration),
[credential validation](https://workos.com/docs/reference/agents/registration),
[MCP authentication](https://workos.com/docs/authkit/mcp).

## Run The Local Fixture

From a checkout with dependencies installed:

```bash
pnpm --filter @koed/api prototype:agent-auth
```

The default URL is `http://127.0.0.1:43555`. Choose another port using
`KOED_AUTH_PROTOTYPE_PORT` if needed. The server refuses non-loopback origins.
It keeps all synthetic state in memory; restarting clears registrations.

Ask a test AI Client:

> Read http://127.0.0.1:43555/auth.md and connect me to this local Koed fixture.
> Ask me to approve the connection. Do not approve it on my behalf and do not
> display credentials. Check access using the MCP diagnostic tool.

The fixture returns an approval URL. Open it, approve the synthetic connection,
and give the displayed code back to the test client. The fixture intentionally
has no real sign-in: anyone holding its local approval URL can act as the
synthetic User. It is **not** an authentication service and must not be exposed
to a network or real data. Its three-step exchange approximates the hosted
claim interaction; it is not a protocol-conformance implementation of WorkOS.

For an automated network smoke while the server is running:

```bash
pnpm --filter @koed/api prototype:agent-auth:smoke
```

This smoke simulates the User, exercises the actual remote MCP route, checks
capture/execution/admin scope denials, and revokes the fixture credential. It
refuses to run in live mode and prints no credentials. No model runs or paid
services are involved.

## Optional WorkOS Staging Test

First confirm in the WorkOS Dashboard that the selected environment is staging,
Agent Registration is available there at no cost, and its identity type is
`service_auth`. Use short-lived access tokens, not durable API keys. Configure
only `koed:memory:read` for the initial test, no anonymous Memory access.

Use these environment variables in a private shell or secret manager, not in
tracked files or AI Client instructions:

| Variable                                | Value                                       |
| --------------------------------------- | ------------------------------------------- |
| `KOED_AUTH_PROTOTYPE_MODE`              | `workos-staging`                            |
| `KOED_AUTH_PROTOTYPE_STAGING_CONFIRMED` | `1`, after checking the environment         |
| `WORKOS_PROTOTYPE_AUTHKIT_URL`          | The staging `https://...authkit.app` issuer |
| `WORKOS_PROTOTYPE_API_KEY`              | That staging environment's server API key   |
| `WORKOS_PROTOTYPE_ORGANIZATION_ID`      | The staging organisation being tested       |
| `WORKOS_PROTOTYPE_USER_ID`              | The signed-in staging WorkOS User ID        |

Start the same command and point the test client at `/auth.md`. This serves the
WorkOS-generated public guide with the local resource identified underneath.
The client follows WorkOS's actual registration and claim endpoints; the User
signs in through WorkOS, not the local fixture. Configure the token audience for
this prototype's resource, `http://127.0.0.1:43555/mcp`, and request it during
token exchange. WorkOS environment configuration may reject loopback resource
indicators; if so, record that limitation rather than weakening audience checks.

No staging credentials are bundled or discovered automatically. If your
environment cannot issue the documented claims or permissions, the resolver
fails closed. Record the actual response shape before adapting it.

## Authentication Boundary

The experiment uses WorkOS's online credential validation endpoint on each
resolution, then reads the registration. It requires a verified, user-bound
registration, the exact issuer/resource/organisation, and an explicitly mapped
WorkOS User. It does not link users by email or provision real Koed accounts.
Decoded JWT claims are trusted only after WorkOS validates the credential with
the expected audience. Revocation is checked online, not inferred solely from
a JWT's expiry. WorkOS errors are redacted.

The resulting principal enters the existing `createAuthHelpers` resolver hook.
Existing scope checks and `registerRemoteMcpRoutes` are reused unchanged. Known
Koed scopes are retained; unknown permissions confer no authority. The synthetic
repository contains one User, and no Team data, captured sources or Memory.

This tests registration-to-authorisation wiring, not retrieval quality, a real
database integration, helper enrollment, LCM, or end-to-end Memory Answers.
The local helper remains required for synthesis and capture. No WorkOS Connect
migration, organisation-to-Team mapping or deployable trust configuration is
implemented. Live WorkOS compatibility and actual hosted UX require a staging
run; fixture success alone does not establish either.

## Targeted Validation

```bash
pnpm exec vitest run apps/api/prototypes/workos-agent-auth/prototype.test.ts
pnpm exec tsc -p apps/api/prototypes/workos-agent-auth/tsconfig.json
pnpm exec eslint apps/api/prototypes/workos-agent-auth/*.ts
```

This is an initial local prototype, with no changeset or PR. A release proposal
needs a separate security review, free-tier confirmation and a migration design
that preserves one authorisation boundary and existing client compatibility.
