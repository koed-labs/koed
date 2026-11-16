# Signed macOS candidate artifacts

This is a manually dispatched, opt-in maintainer testing path for a same-repository
PR. It does not create a GitHub Release, tag, npm package, update feed, or
production promotion. The workflow must first be reviewed and merged to protected
`main`; its unmerged copy cannot safely sign itself. **Do not configure the
candidate environment or supply credentials until the workflow and its security
review have been approved.** A real Developer ID/notarization run and a clean-Mac
acceptance test remain separate qualification gates.

## Trust boundary

The build job checks out and executes the requested PR **without Apple signing or
notarization credentials**. A fresh trusted-main inspector downloads the run's
unsigned artifact, checks its archive and bundle, independently hashes it, and
posts a tuple to the workflow summary. A protected environment requires an
independent reviewer to inspect the exact tuple and candidate changes before
approval. The fresh signer checks the tuple, current PR head, protected main,
environment policy, artifact ID, and digest again before signing. It processes
candidate files as hostile data and does not run candidate executables, scripts,
hooks, entitlements, packaging configuration, or dependencies.

The signer uses a temporary keychain and trusted-main signing code and
entitlements, refreshes runtime manifests after nested signing and before the
outer seal, then notarizes and staples an app ZIP and a DMG. It uploads an
explicitly **UNVERIFIED** intermediate. A separate runner without Apple signing
material verifies hashes, Team ID, signatures, Gatekeeper and stapling, then runs
trusted-main smoke of the candidate-reported CLI version and Desktop ready/quit
lifecycle.
A final fresh job re-downloads the original signed bytes,
checks their hashes, and uploads a tester-ready artifact only after smoke succeeds.
The intermediate can still be downloaded by people with Actions access; it is not
a passed candidate. Artifacts are retained for 14 days and are not confidential.

The candidate controls its own app and can fabricate smoke responses; this basic
smoke does not check service health. Passing it and receiving a Developer ID
signature do **not** establish that the
candidate is trustworthy or safe. A digest binds the reviewed run's bytes; it does
not prove those bytes were faithfully built from the displayed commit, because the
candidate controls its own build. Test only reviewed candidates on a disposable
Mac or a separate macOS user without personal data. `KOED_HOME` alone does not
isolate all macOS registration, login items, Electron user data, or device proofs.

GitHub environment approval applies to the **run**, not a cryptographic signature
by a reviewer over the tuple. The inspector displays the tuple before the job waits
for approval, and the signer revalidates it, but a reviewer must manually compare
the run, tuple and source. If main, PR head, artifact, team, or environment policy
changes, the job fails; dispatch a new run and review it again. Maintainers with
repository/environment administration authority can change these controls, so
restrict that authority and monitor changes.

## Administrator setup — separate authorization required

1. Review the implementation, independent security review and ad-hoc feasibility
   evidence. Verify this workflow and the trusted signer are on protected `main`.
2. Create the separate `desktop-candidate-signing` environment. Set required
   reviewers, **prevent self-review**, and disallow administrator bypass. Set
   custom deployment-branch policies to exactly the `main` branch; do not allow
   tags or wildcard branches. Ensure `main` is protected. The workflow checks
   these settings through the GitHub API and fails closed if it cannot verify them.
   GitHub plan or permission restrictions can prevent these controls; do not use
   this path if they cannot be established.
3. Only after explicit approval, configure the following **environment secrets**;
   do not use repository-level secrets or send them to PR workflows:

   | Secret                              | Value                                                       |
   | ----------------------------------- | ----------------------------------------------------------- |
   | `CANDIDATE_P12_BASE64`              | Standard single-line base64 Developer ID Application `.p12` |
   | `CANDIDATE_P12_PASSWORD`            | Nonempty `.p12` export password                             |
   | `CANDIDATE_APPLE_API_KEY_P8_BASE64` | Standard single-line base64 App Store Connect `.p8`         |
   | `CANDIDATE_APPLE_API_KEY_ID`        | Apple API key ID                                            |
   | `CANDIDATE_APPLE_API_ISSUER`        | Apple API issuer UUID                                       |

4. Set repository variable `DESKTOP_MACOS_APPLE_TEAM_ID` to the expected ten-character
   Team ID so the uncredentialed build and inspector can see it. The environment
   may also define it, but the signer rejects a value different from the reviewed
   tuple. Use a dedicated testing signing identity/account where possible. Never
   commit or print credential material.

The macOS `security` tool receives the transient keychain password and `.p12`
password as process arguments. A fresh isolated runner and the absence of candidate
execution in that job limit exposure, but administrators must restrict runner and
job diagnostics access; do not use a persistent self-hosted runner. Cleanup failure
fails the job and prevents artifact upload.

## Dispatch and review

1. Choose an open PR whose head repository is `koed-labs/koed` and whose base is
   `main`; fork PRs are not accepted. Resolve and review its **full 40-character
   head SHA**. The candidate can contain arbitrary code even if the PR is trusted.
2. In Actions, choose **Signed macOS candidate artifact**, select `main`, and
   dispatch with the PR number and exact head SHA. Never select an unmerged branch
   as the workflow ref. The uncredentialed build may take significant time.
3. Open the run summary after inspection and compare repository, PR number, head
   SHA, workflow SHA, run ID/attempt, unsigned artifact ID and SHA-256, expected
   Team ID, and version with the intended reviewed candidate. Check the candidate
   diff and confirm the requester is not the approver. Approve the protected job
   only if every value is correct. Approval does not itself authenticate the tuple.
4. Wait for signing, platform verification and smoke to finish. Download only the
   `koed-macos-candidate-pr…` artifact from that successful run; an `UNVERIFIED-…`
   intermediate is not equivalent. The artifact contains `Koed.zip`, `Koed.dmg`,
   and `provenance.json` with the input tuple and both output SHA-256 values.
   Check downloaded file hashes against that provenance and the run before use.
5. On an isolated test Mac, preserve quarantine and launch normally. Record the
   candidate SHA, output digest, macOS version, signature/Team ID, and Desktop and
   Background Agent results. A successful Actions run is not a substitute for real
   clean-Mac acceptance or for the separate production release gates.

If the workflow fails or a tuple changes, do not work around the gate or manually
promote the intermediate. Inspect redacted job diagnostics, fix the cause, and
dispatch a fresh run. If cleanup or ownership is uncertain, preserve diagnostic
evidence without uploading secrets or personal Memory. Never print private keys,
passwords, tokens, or presigned artifact URLs in logs or support reports.
