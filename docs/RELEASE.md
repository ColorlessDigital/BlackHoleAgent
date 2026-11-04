# Windows Development Prerelease

Repository: https://github.com/ColorlessDigital/BlackHoleAgent

Release tag: `v1.0.0-stabilized.13`.
This distributes the existing `go-stabilized-13` Windows x64 build. It is not a
new binary rebuild or a claim of production readiness.

## English Documentation Update

The default README, project site, guides and demo images on
[main](https://github.com/ColorlessDigital/BlackHoleAgent) are now in English.
Use the additional
[English source snapshot](https://github.com/ColorlessDigital/BlackHoleAgent/releases/download/v1.0.0-stabilized.13/BlackHoleAgent-source-english-v1.0.0-stabilized.13.zip)
and `SHA256SUMS-English.txt` for this documentation update. The original tag,
source snapshot, executable assets and their checksum files remain unchanged.
This is documentation localization, not a new application build.

## Downloads

- `blackhole.exe`: portable launcher; no setup installation required.
- `BlackHole-Setup.exe`: installer with certificate-store side effects below.
- `blackhole.zip`: ZIP containing the same portable executable, not model weights.
- `BlackHoleAgent-source-v1.0.0-stabilized.13.zip`: public source snapshot.
- `BlackHole-third-party-notices.zip`: upstream license/notices companion.
- `RELEASE_INFO.json` and `SHA256SUMS.txt`: build identity and asset verification.

GGUF models and provider API keys are not included. User settings, private
conversation/diagnostic data and the developer's original Git history are not
part of the release. Enter credentials locally; never put them in issues.

## Important Warnings

This is a development prerelease. Known dependency audit findings remain,
including a Critical finding in the application dependency tree. Automated
checks are not a security certification or an arbitrary-repository benchmark.
See `PUBLIC_VALIDATION.json` for the recorded baseline and limitations.

The build is signed with a local self-signed CA, not a publicly trusted code
signing identity. Windows may warn about publisher trust. The Setup installer
imports the bundled public CA into `Cert:\LocalMachine\Root`; its uninstaller
contains removal operations for certificates with the project's CA subject.
Do not treat a public CA file shipped alongside an executable as an independent
trust proof. Review `blackhole/build/installer.nsh` and
`blackhole/scripts/sign-release.ps1` before choosing Setup. The portable
launcher avoids the Setup-specific certificate installation step.

The published source differs from the original binary's source fingerprint
only in the previously documented public diagnostic helper defaults; the
documentation and presentation assets also have publication-specific links.
No agent prompt censorship, approval policy, model settings or runtime source
behavior was changed for publication. `RELEASE_INFO.json` records both source
fingerprints, the binary payload hash and asset hashes.

Historical local checks recorded 404 backend and 10 frontend tests, package
checks and two fixed packaged stability matrices. Those are not rerun live
model benchmarks for publication. Linux/macOS and cross-PC installation trust
are not certified by this Windows release.

Use SHA-256 to compare downloaded files with `SHA256SUMS.txt`. Package-owned
licenses and marks retain their upstream terms; the notices companion and
source lockfile inventory are not a complete independent legal audit.
