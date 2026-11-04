# Agent Platform Regression

Agent platform changes must keep core tests, workspace rules, MCP compatibility, and the IDE bridge visible in PR checks.

- level: must-pass
- changed-only: true
- applies-to: src/agent/**/*, src/ide/**/*, src/mcp/**/*, src/config/**/*, scripts/**/*
- forbid-text: process.exit(0)
- require-file: .blackhole/rules/coding-standard.md
- require-file: .blackhole/prompts/agent.md
- require-script: npm test
- require-script: npm run check:workspace-rules
- require-script: npm run check:vscode-extension
