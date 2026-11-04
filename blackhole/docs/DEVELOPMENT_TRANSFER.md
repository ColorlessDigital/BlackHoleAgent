# Development Source Transfer

This ZIP contains source and reproducible build inputs, not dependencies or
runtime binaries. It differs from older private development transfers which
included Windows Node/llama.cpp distributions.

1. Extract everything, keeping the application and extension siblings.
2. From the root run `tools/bootstrap-windows.ps1` in PowerShell. It downloads
   pinned official runtimes, verifies archive SHA-256 and runs `npm ci` for
   the application, frontend and VS Code extension.
3. Add the Node directory to PATH, enter `blackhole`, run backend/frontend
   tests, then `npm run build:frontend` and `npm start`.
4. Download GGUF weights separately and select the model/workspace in the app.
   Enter provider credentials locally in Settings.
5. Review certificate behavior before `npm run build:windows`. Do not copy
   maintainer private signing keys or assume a local CA is publicly trusted.

See [the root README](../../README.md) for commands and exclusions. Linux
scripts need a Linux host and separate validation. There is no Git history,
user config, chat or keychain in this ZIP. The older private
`build-dev-archive.ps1` includes runtimes and is not this public export process.
