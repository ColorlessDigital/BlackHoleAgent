# Publishing BlackHole Source and Windows Assets

Repository: [ColorlessDigital/BlackHoleAgent](https://github.com/ColorlessDigital/BlackHoleAgent).
[Project page](https://colorlessdigital.github.io/BlackHoleAgent/).

## Version Discipline

The current source/docs target stabilized31. Keep previous tags and release assets
unchanged. Build30's hour, build29's checkpoint work and build13's former public
baseline remain historical, not newer executable measurements.

Use root PUBLIC_SOURCE_PROVENANCE.json for maintainer-binary and public-source
fingerprints, PUBLIC_VALIDATION.json for independently rerun source checks, and
docs/validation for sanitized packaged evidence. Do not copy internal raw logs.

## Public Source

Export source, tests, lockfiles, audited example configuration, docs and demo
assets. Exclude installed dependencies, runtime binaries, models, user data,
secrets, private conversations, diagnostics, signing keys and original private
Git history. Preserve owner attribution and third-party terms.

The diagnostic proof/GGUF helper default paths are portable in the export.
No agent runtime, censorship, prompts/rules or approval-policy edit is introduced
by publication. Verify this against the tested binary source, not merely Git HEAD.

After final file changes, regenerate SOURCE_MANIFEST.json from Git-normalized
public bytes, excluding itself. Inventory lockfile versions/licenses again.
Scan text, binaries, archives and metadata; compare known stored credentials
in memory without printing or copying them into reports.

## English Presentation

Keep README.md and README.en.md synchronized. docs/index.html/styles.css/site.js
and docs/images form the buildless GitHub Pages site. The UI screenshots use
scripted, labeled public data; live validation evidence is separate.

Preserve the difference between saved edits, verified behavior and unavailable
checks. Do not turn a passing fixture into an arbitrary-task claim.

## Release

Create a new development prerelease tag, upload the unchanged verified portable,
Setup and portable ZIP, the audited source ZIP, notices, release identity and
SHA256SUMS. Compare server asset digests with local SHA-256.

Build31 Setup no longer imports/removes trust-store certificates automatically.
Legacy13/14 warnings remain relevant to their unchanged assets. Development
signing on the build machine still provisions a self-signed CA; this is not
public-CA trust or clean-PC installation proof.

## Pages and Final Checks

Pages uses main and /docs. Verify the resulting deployment commit/status and live
page, not just a successful Git push. Check navigation, relative assets, release
links and desktop/mobile layout. Never publish before the privacy/source checks.
Use noreply author metadata for new maintainer commits; existing public history
is preserved rather than silently rewritten.
