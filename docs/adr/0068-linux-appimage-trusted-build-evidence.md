# ADR 0068: Linux AppImage Candidate Verification Uses Trusted-Build Evidence

Status: Accepted.

Related decisions:

- [0057 Versioned Component Manifest Pins](0057-versioned-component-manifest-pins.md)
- [0067 Independently Versioned Linux Native Runtime](0067-independent-linux-native-runtime.md)

## Context

Release candidate verification inspects every Desktop artifact without
executing it. For macOS, it extracts `app.asar` from the Desktop ZIP and checks
the embedded component catalog against the reviewed catalog.

An AppImage is an ELF runtime followed by a SquashFS image. Extracting its
`app.asar` in the protected verifier means parsing an untrusted SquashFS image.
An experimental bounded SquashFS inspector could not show that it reads hostile
layouts the same way as the AppImage runtime. Duplicate names, hardlinks,
forged table indexes and metadata exhaustion remained unresolved. While that
was unresolved, the verifier rejected every Linux candidate. This also blocked
the combined release.

## Decision

The reviewed release build produces the AppImage. That same job then extracts
the AppImage it just built and verifies the embedded catalog against the frozen
reviewed catalog. It records the result in
`koed-desktop-linux-x64.evidence.json`:

- repository, commit, run ID and run attempt
- version
- AppImage name and SHA-256
- `resources/app.asar` SHA-256
- catalog SHA-256

The evidence is retained with the AppImage and checksum in the
`koed-desktop-linux-final-assets` artifact. It is published as a release asset.

Candidate verification never parses or executes the AppImage. The AppImage,
checksum and evidence bytes must match the protected reviewed-build identity.
The evidence must name the reviewed repository, commit, run and version, and
the AppImage hash it records must match the protected AppImage hash. The
evidence must also record the candidate's catalog hash. The checksum file must
name exactly that hash and asset.

## Consequences

- Assurance for the AppImage contents depends on the integrity of the reviewed
  build job and its runner. It does not rest on independent inspection.
  A compromised build job could produce a malicious AppImage together with
  matching evidence. The macOS path inspects the artifact independently, so it
  does not carry this dependency.
- The verifier no longer needs a SquashFS parser. The experimental inspector is
  removed.
- Reversing this decision requires an independent AppImage inspector whose
  behaviour on adversarial images matches the AppImage runtime, together with
  review of that equivalence.
