# Local Windows Signing and Certificates

Review `../scripts/sign-release.ps1` and `../build/installer.nsh` before use.
This export does not alter their existing behavior.

The script uses or creates a BlackHole Root CA and Publisher certificate in
`Cert:\CurrentUser\My`, with non-exportable new private keys. It trusts the CA
in `Cert:\CurrentUser\Root` on the build PC and exports its public `.cer` for
packaging. The installer contains machine certificate-store operations;
inspect their scope before distribution. Original developer certificates
and private keys are not supplied in this ZIP.

A self-signed local certificate is not a publicly trusted publisher identity
and does not guarantee cross-PC installation trust. Never trust a CA solely
because it arrived alongside an executable.

Certificate thumbprints and SHA-256 file hashes are different identifiers.
Compare like with like over an independent trusted channel: compare the
certificate object's `Thumbprint` on both ends, or SHA-256 of the same exported
file. Track expiry, rotation and removal yourself. No public CA revocation
service or production publisher enrollment is provided by these scripts.

`sign-release.ps1` accepts `-RepoRoot`, `-KeepDist` and
`-PrepareCertificatesOnly`. Packaging can change the certificate store even
if a later build step fails. The bootstrap script does not perform certificate
operations. The obsolete elevation-based root launcher is not included.
