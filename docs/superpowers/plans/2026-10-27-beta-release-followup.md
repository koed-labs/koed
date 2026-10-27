# Beta Release and Desktop Rollout Follow-up

**Status:** Draft; separate from the reduced #421 release remediation. Not approved for implementation.

## Goal

After #421 → #428 → #432 are merged and the existing stable release mechanism has passed its acceptance gates, design a release cycle where a Release PR merge initiates an automated real SemVer prerelease (for example `1.2.3-beta.1`), followed by an independently authorized manual stable promotion to `1.2.3`.

## Required design decisions

- **Version and provenance:** define how the beta version and source derive from the reviewed Release PR, and prove the association using protected branch and GitHub evidence. A stable version is distinct: npm packages, versioned manifests, embedded catalog pins and signed Desktop artifacts cannot simply be relabelled beta bytes. Define what the manual approval authorizes and when the new stable candidate is independently verified.
- **Trusted execution:** run privileged publication and verification workflow code from a protected trusted ref, not an untrusted candidate tag. Bind source, candidate identity, independent reviewer and workflow attempt; test rerun and replay behavior.
- **Channel isolation:** beta GitHub releases and npm `beta` must not move stable `latest`; test real update-discovery behavior. Define prerelease SemVer selection and prevent downgrade/concurrent writers.
- **Recovery:** retain authenticated original build evidence and define safe recovery after each partial publication failure. Published assets are immutable; never reconstruct authority from mutually consistent remote assets alone.
- **Build reuse:** measure native payload caching and component staged-tree reuse between prerelease and stable. Linux release already reuses validated payloads; macOS signed release currently builds native payload cold despite a maintained cache. Fresh stable manifests, catalog, package identity, signing, notarization and acceptance still apply. Cache writers and keys must be trusted and complete.
- **Desktop staged rollout:** integrate into the later automatic-download/restart milestone, not the notice-only milestone. Explore a 36-hour stable linear ramp, immediate beta, and an Operator-controlled zero-duration override; determine whether manual checks bypass rollout and how downloaded updates behave when superseded. Do not treat these example settings as approved requirements. Rollout does not replace signed-artifact verification or runtime replacement safety and cannot constrain old clients that do not implement it.

## Acceptance

Require end-to-end beta → independently approved stable verification using real version-bound components, published candidate artifacts, native Personal/Team flows and clean-Mac signed/notarized update acceptance. Prove failed checks produce no unintended stable publication, and document external npm writer, GitHub environment and retry assumptions. No real publication or owner-side setting changes are authorized by this draft.
