# BlackHole

[한국어](README.md) · [Demo guide](docs/DEMO.md) · [GitHub Pages setup](docs/PUBLISHING.md)

[Repository](https://github.com/ColorlessDigital/BlackHoleAgent) ·
[Windows development prerelease](https://github.com/ColorlessDigital/BlackHoleAgent/releases/tag/v1.0.0-stabilized.13) ·
[Project page](https://colorlessdigital.github.io/BlackHoleAgent/)

Use `blackhole.exe` for portable execution; download GGUF weights separately.
Known dependency audit findings remain. The Setup executable imports the
project's self-signed CA into the machine certificate store. Review the
signing/installer scripts and release warnings before running it.

![BlackHole desktop interface with scripted public demo data](docs/images/overview.png)

The screenshots use the real built frontend with controlled API/SSE fixtures,
not a live model session, benchmark result or personal conversation. The
application is under active development; known dependency audit findings remain.

BlackHole is an Electron desktop coding agent with a llama.cpp-based local
GGUF runtime. Optional OpenAI-compatible gateways and OpenCode Go are supported.
It includes a React frontend, file/terminal/web/MCP tools, checkpoints, execution
records, context compaction, recovery, and a companion VS Code extension.

This is a development source snapshot, not a model distribution or an assurance
of unattended production reliability. Provider access and model availability
depend on the provider and account. No model or API credential is included.

## Layout

- `blackhole/src`: application, server, agent, runtimes, tools and tests.
- `blackhole/frontend`: React/Vite interface and frontend tests.
- `blackhole/scripts`, `blackhole/build`: checks, packaging and signing.
- `blackhole/benchmarks`: reproducible evaluation fixtures.
- `blackhole/.blackhole`: source-controlled workspace standards and examples.
- `vscode-blackhole`: VS Code extension source, tests and packaging resources.
- `tools/bootstrap-windows.ps1`: pinned Windows runtime downloads and checks.

## Windows Development

Run from the extracted repository root in PowerShell. The bootstrap downloads
Node 24.21.0 and llama.cpp b9553 Vulkan x64 from their official distributions,
verifies SHA-256, and installs the three lockfile-defined dependency trees.
It does not download a GGUF model, import a certificate or change app settings.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/bootstrap-windows.ps1
$env:Path = (Join-Path $PWD 'node-v24.21.0-win-x64') + ';' + $env:Path
Set-Location blackhole
npm test
npm --prefix frontend test
npm run build:frontend
npm start
```

Choose your separately downloaded GGUF model and workspace in Settings. Cloud
provider credentials must be entered locally. Do not upload secrets, chats or
your runtime data directory. OS-encrypted credentials are not portable to a
different PC or user.

## Checks and Packaging

```powershell
npm run check:backend
npm run check:workspace-rules
npm run release:check -- --skip-extension-e2e
npm run build:windows
```

The extension host E2E check, browser visual checks and live-model evaluations
have additional prerequisites and are not equivalent to unit tests. See the
scripts and `blackhole/docs` for their scope. The `pr:check` diff step expects a
Git repository; the ZIP intentionally has no `.git` history.

**Signing side effects:** the existing Windows build script creates a local
self-signed CA and publisher certificate in `CurrentUser\My`, trusts that CA in
`CurrentUser\Root`, and packages its public certificate. The installer also
contains certificate trust operations. Review `blackhole/build/installer.nsh`
and `blackhole/scripts/sign-release.ps1` before building or distributing. A
local signature is not a publicly trusted publisher identity. No original
developer private key or certificate is included in this source archive.

Linux setup/build scripts exist in `blackhole/scripts`; build and validate on a
Linux host. This Windows source export does not certify Linux/macOS releases.

## License and Export Scope

BlackHole-owned code and documentation are licensed under Apache-2.0; see
[LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party components and marks retain
their own terms; see [THIRD_PARTY.md](THIRD_PARTY.md).

The public source ZIP excludes installed dependencies, runtime binaries,
models, previous builds, Git history, private diagnostics, user configuration,
certificates and chats. Keep package manifests, lockfiles, tests, benchmark
fixtures and source-controlled workspace standards together. Internal raw work
logs are replaced by public handoff documentation in the export only.
