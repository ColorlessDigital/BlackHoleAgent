# BlackHole Signing and Root CA Operations

Self-signed local CA used ONLY to sign local BlackHole build artifacts.
It is NOT a public CA and must never be exported with its private key.

## 1. Installer trust behavior

Starting with stabilized build 15, installation and uninstallation do not import
or remove certificates from Windows trust stores. A self-signed publisher is
not publicly trusted, and users may see Windows trust warnings. Do not solve
those warnings by silently importing a development root CA.

Builds 13 and 14 used an older installer which imported a root certificate and
removed certificates by subject during uninstall. Review legacy installations
separately. Never remove all certificates sharing a subject; verify the exact
certificate and its ownership first.

## 2. Fingerprint verification

After `npm run build:exe`, `sign-release.ps1` prints a certificate identifier:

```
Thumbprint: <certificate-thumbprint>
```

The Windows certificate `Thumbprint` is not the SHA-256 hash of the `.cer` file.
Compare like-for-like values through an independent channel. The build metadata
records the certificate thumbprint and validity; use a separate SHA-256 digest
when verifying the downloaded certificate file itself.

The development signing script still creates or reuses a local CA/Publisher in
`CurrentUser\My` and trusts its CA in `CurrentUser\Root` on the build PC. This is
a build-machine provisioning side effect, not an installer operation or a public
code-signing identity. Do not run the build signing script on an end-user PC.

## 3. Key storage

- Private key: `Cert:\CurrentUser\My` on the BUILD machine only, created with `KeyExportPolicy NonExportable`.
- Public cert only: `windows/BlackHoleRootCA.cer` + `blackhole/BlackHoleRootCA.cer` (packaged as `extraResources`).
- Never commit `*.pfx` / private keys. `.gitignore` blocks `*.pfx`.

## 4. Validity and rotation

- Validity: inspect the actual existing certificate's `NotAfter`; creation defaults do not extend an older certificate's validity.
- Rotation: review the exact signing certificate and thumbprint on the build machine, provision its replacement, and rebuild. Do not delete certificates solely by subject or assume uninstall rotates trust.
- Revocation: no CRL (offline local CA). Compromise response = rotate + rebuild + notify thumbprint out-of-band.

## 5. Reproducible paths

`sign-release.ps1` takes `-RepoRoot` (defaults to repo-relative `$PSScriptRoot\..\..`) and `-KeepDist`.
No `d:\BlackHole` hardcoding remains. `windows/BUILDINFO.json` records `{ builtAt, gitSha, rootCaThumbprint, rootCaNotAfter, codeSignThumbprint }`.

`scripts/test-windows-install.ps1` is an opt-in test for a disposable clean,
elevated Windows host. It checks installation, a same-build upgrade, payload
identity, preservation of a synthetic configuration, removal, and unchanged
trust stores. Static checks or successful signatures on the build PC do not
substitute for that clean-host test.
