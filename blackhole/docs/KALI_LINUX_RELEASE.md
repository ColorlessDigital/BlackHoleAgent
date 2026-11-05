# Kali Linux Release Plan

Public source baseline: stabilized31. The Windows publication does not certify
a build31 Linux package. The drift snapshot below remains historical; run the
documented build and packaged smoke checks on a real Linux host before claiming parity.

BlackHole keeps one shared agent core and separates only platform runtime and packaging.

- Shared core: `src/agent`, `src/mcp`, `src/ci`, `src/ide`, `src/web`, `frontend`
- Windows package: `npm run build:exe`
- Kali/Linux package: `npm run build:kali`
- Runtime staging: `resources/node-runtime/current`
- llama.cpp staging: `resources/llama.cpp/<platform>-<arch>/llama-server`

## Why Windows Stays Separate

Windows and Kali must not be maintained as two forked products. The agent loop, tool registry, MCP layer, PR checks, autocomplete, reports, and UI stay shared. Only these layers are platform-specific:

- Node runtime bundle
- llama.cpp server executable
- shell command adapter
- GUI file picker fallback
- IDE detection and VS Code CLI path
- electron-builder target
- signing and release artifact sync

This keeps behavior consistent while preventing Windows-only paths such as `node-v24.21.0-win-x64`, `cmd.exe`, `powershell`, and `llama-server.exe` from leaking into Kali execution.

## Kali Target

Kali is a rolling distribution. Build against the current `kali-rolling` environment rather than pinning the app to a single ISO image. Official references:

- [Kali update docs](https://www.kali.org/docs/general-use/updating-kali/)
- [Kali current images](https://cdimage.kali.org/current/)
- [Kali download page](https://www.kali.org/get-kali/)

Linux packages use electron-builder Linux targets:

- AppImage for portable demo use
- deb for normal Kali install
- tar.gz for inspection or manual deployment

References:

- [electron-builder Linux targets](https://www.electron.build/docs/linux/)
- [electron-builder AppImage](https://www.electron.build/docs/appimage/)

llama.cpp is used directly through `llama-server`, which provides OpenAI-compatible routes and can be built CPU-only or with CUDA when available.

- [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama.cpp build docs](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)

## Drift Status (2026-10-01)

`npm run check:parity` reports the Windows-vs-Linux gap. Windows was rebuilt
on 2026-10-01 with Electron 44.5.1, electron-builder 26.15.3 and Node 24.21.0.
The local Linux artifacts remain from 2026-06-07 and have no BUILDINFO.
Linux execution has not been verified on the current Windows PC.

Both build scripts write BUILDINFO with `gitSha`, `gitDirty`, `sourceHash`,
runtime versions and platform. The source hash normalizes text line endings
and includes uncommitted build inputs. Equal Git SHAs alone are insufficient;
`check:parity` requires matching source fingerprints as well.

Check anytime (read-only, exit 2 on drift):

```bash
npm run check:parity
```

## One-Time Kali Build

Run as a normal desktop user from the BlackHole project root on Kali.
Use a current Node 24 LTS installation to invoke npm; the script stages
Node 24.22.2 for the app's MCP runtime. apt installation may request sudo:

```bash
npm run build:kali
```

The script performs:

1. apt dependency install
2. Node.js Linux runtime download
3. llama.cpp clone/build at `b9553` (the Windows runtime's source revision)
4. `resources/node-runtime/current` preparation
5. root/frontend/VS Code extension dependency install
6. Kali release quality check
7. AppImage, deb, and tar.gz packaging with Linux-only runtime resources
8. packaged app launch/API/secret round-trip/TypeScript and executable checks
9. source fingerprint metadata and sync to the parent `linux/` directory

The build stops on missing artifacts or failed smoke tests. Without DISPLAY,
the packaged app check uses Xvfb and a temporary D-Bus session. A headless
`basic_text` secret backend is reported explicitly, not as an OS keychain.

Output:

```text
dist/BlackHole-1.0.0-x64.AppImage
dist/BlackHole-1.0.0-*.deb
dist/BlackHole-1.0.0-x64.tar.gz
dist/BUILDINFO.json
```

## Manual Runtime Setup

If you only want to prepare runtime resources:

```bash
bash scripts/setup-kali-runtime.sh
```

Useful environment variables:

```bash
SKIP_APT=1 bash scripts/setup-kali-runtime.sh
LLAMA_SERVER_PATH=/usr/local/bin/llama-server bash scripts/setup-kali-runtime.sh
LLAMA_CPP_SOURCE=/opt/llama.cpp bash scripts/setup-kali-runtime.sh
NODE_VERSION=24.22.2 bash scripts/setup-kali-runtime.sh
LLAMA_CPP_REF=b9553 bash scripts/setup-kali-runtime.sh
BUILD_JOBS=2 bash scripts/setup-kali-runtime.sh
```

## Verification

After runtime setup:

```bash
npm run release:check:kali
```

The Kali check validates:

- backend syntax
- backend unit tests
- frontend build
- VS Code bridge compile/package
- E2E corpus shape
- MCP Node runtime packaging
- Linux `llama-server` presence

`release:check:kali` skips extension-host E2E by default because it may require a running VS Code desktop session. Use the regular `npm run test:vscode-extension` on a GUI Kali desktop when VS Code is installed.

`setup-kali-runtime.sh` verifies the Node download's SHA256, builds llama/ggml
statically while retaining CUDA when nvcc is available, and checks the staged
server for missing shared libraries. It never silently pulls or resets an
existing custom llama.cpp checkout. Set LLAMA_CPP_SOURCE and LLAMA_CPP_REF to
the revision you intend to build when using a custom checkout.

## Linux CI

The root `.github/workflows/blackhole-linux-release.yml` builds on Ubuntu
22.04 for pull requests or manual dispatch, runs the same Linux package smoke
test, and uploads binaries, BUILDINFO and diagnostics. It is a build-validation
job, not an automatic public release or proof of Kali desktop compatibility.

The current repository has no remote configured, so this workflow has not
been executed. Source, lock files, benchmarks, extension resources/tests and
the workflows must all be committed together before a fresh checkout can run
it. A successful Linux runner or real Linux PC run is still required.

## Runtime Paths

Packaged app paths:

```text
process.resourcesPath/node-runtime/bin/node
process.resourcesPath/llama.cpp/linux-x64/llama-server
~/.config/BlackHole/config.json
```

Development paths:

```text
resources/node-runtime/current/bin/node
resources/llama.cpp/linux-x64/llama-server
data/config.json
```

## Expected Feature Parity

The Kali build should preserve:

- GGUF model selection
- managed llama.cpp runtime start/stop
- Chat/Edit/Agent/Autocomplete modes
- MCP client and BlackHole MCP server
- workspace config/rules/prompts
- PR check mode
- reports and benchmark UI
- VS Code extension install through `code` or `codium`
- terminal execution through `$SHELL`
- Linux absolute workspace paths such as `/home/user/repo`

## Windows Release

Windows remains separate:

```powershell
npm run build:exe
```

This command prepares the Windows Node runtime, builds the frontend, packages Windows NSIS/portable artifacts, and runs the Windows signing/sync script. Do not run Windows signing from Kali.
