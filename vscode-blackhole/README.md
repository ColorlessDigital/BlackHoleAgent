# BlackHole Developer Agent for VS Code

This extension connects VS Code to the local BlackHole desktop agent.

## Requirements

- Start the BlackHole desktop app first.
- The local API gateway should be available at `http://127.0.0.1:3003`.
- If BlackHole starts on a fallback port, the extension scans nearby local ports automatically.

## Features

- Activity bar panel for BlackHole chat.
- Connects to the local BlackHole API using the `/api/bootstrap` session token.
- Syncs the current VS Code workspace into BlackHole.
- Streams `/api/chat` agent events into the sidebar.
- Attaches selected editor code to prompts.
- Resumes the latest BlackHole checkpoint.
- Shows tool, state, terminal, and status events while the agent runs.
- Provides native editor inline completions through `/api/ide/autocomplete`.
- Rewrites selected code in-place through `BlackHole: Inline Edit Selection`.
- Adds quick-fix, CodeLens, and context-menu entry points for diagnostics and selected code.
- Reviews recent BlackHole patch transactions as diff documents in VS Code.
- Accepts, rejects, and rolls back BlackHole agent diffs from VS Code commands.
- Runs full BlackHole agent tasks directly from VS Code and hands off new patch transactions to diff review.

## Commands

- `BlackHole: Focus Agent`
- `BlackHole: Connect to Local Agent`
- `BlackHole: Sync Current Workspace`
- `BlackHole: Attach Selection to Context`
- `BlackHole: Ask About Selection`
- `BlackHole: Resume Latest Checkpoint`
- `BlackHole: Explain Selection`
- `BlackHole: Inline Edit Selection`
- `BlackHole: Fix Diagnostics`
- `BlackHole: Generate Inline Completion`
- `BlackHole: Review Agent Diffs`
- `BlackHole: Accept Agent Diff`
- `BlackHole: Reject Agent Diff`
- `BlackHole: Rollback Agent Diff`
- `BlackHole: Run Agent Task`
- `BlackHole: Run Agent Task With Selection`

## Settings

- `blackhole.apiBaseUrl`: local API base URL, default `http://127.0.0.1:3003`
- `blackhole.autoSyncWorkspace`: sync the current VS Code workspace after connecting
- `blackhole.inlineCompletions.enabled`: enable native editor inline completions
- `blackhole.inlineCompletions.debounceMs`: delay before requesting an inline completion
- `blackhole.inlineCompletions.maxPrefixChars`: maximum prefix context sent to BlackHole
- `blackhole.inlineCompletions.maxSuffixChars`: maximum suffix context sent to BlackHole

## Manual Build

```powershell
cd D:\BlackHole\vscode-blackhole
D:\BlackHole\node-v20.19.2-win-x64\node.exe node_modules\typescript\bin\tsc -p ./
```

## Manual Install Into VS Code

```powershell
cd D:\BlackHole\blackhole
D:\BlackHole\node-v20.19.2-win-x64\node.exe scripts\install-vscode-extension.js
```

Restart VS Code after manual installation if the BlackHole activity bar does not appear immediately.

## Package And Test

```powershell
cd D:\BlackHole\blackhole
D:\BlackHole\node-v20.19.2-win-x64\node.exe scripts\package-vscode-extension.js
D:\BlackHole\node-v20.19.2-win-x64\node.exe scripts\test-vscode-extension-e2e.js
```

The VSIX artifact is written to `D:\BlackHole\blackhole\dist\vscode-blackhole.vsix`.
The packaged-app copy is written to `D:\BlackHole\blackhole\resources\vscode\vscode-blackhole.vsix` so `BlackHole.exe` can install the bridge without depending on the external source folder.
