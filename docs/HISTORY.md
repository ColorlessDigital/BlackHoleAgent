# Release and Validation History

Keep source versions, executable versions and test scopes separate.

| Version | Status and evidence |
|---|---|
| Stabilized 31 | Current Windows prerelease. Behavioral-completion regression 9/9; real Go 8/8 and 4B implementation fixes 3/3; default product verifier. Backend 507 pass + 1 skip. |
| Stabilized 30 | Historical 60-minute natural-GC run: 553/553, including one intentional cancellation. Four retained context engines maximum; this was not rerun for 31. |
| Stabilized 29 | Historical long-conversation corrections and checkpoint resumes; not a new build-31 measurement. |
| Stabilized 27 | A prior 4B syntax-valid/behavior-wrong attempt failed. Its explicit repair fixed assertions but remained incomplete after a tool failure. Later success does not erase it. |
| Stabilized 13 | Previous public release and English documentation snapshot. 404 backend tests and older dependency/installer findings belong to that snapshot. |

[Current release](RELEASE.md) | [31 evidence](validation/stabilized-31.json) |
[30 evidence](validation/stabilized-30.json) |
[Archived 13 validation](history/stabilized-13/PUBLIC_VALIDATION.json) |
[Unchanged public 13 release](https://github.com/ColorlessDigital/BlackHoleAgent/releases/tag/v1.0.0-stabilized.13)

## Legacy Installer Warning

Builds 13 and 14 used an installer that imported a self-signed root certificate
and removed certificates by subject during uninstall. This remains relevant to
those old executables; updating this documentation does not change them.

Starting with build 15, installation/uninstallation no longer imports/removes
trust-store certificates automatically. The development signing script's
build-machine CA provisioning remains a separate side effect.

The archived build-13 validation includes Critical/High advisories from that
time. Current audits apply to current lockfiles, not retroactively to old assets.
Existing release tags/assets are preserved; no old binary is silently replaced.
