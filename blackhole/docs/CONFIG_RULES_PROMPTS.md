# BlackHole Config, Rules, and Prompt Standard

BlackHole supports project-local configuration under `.blackhole/` so the agent can be operated as a workspace-aware product instead of a UI-only tool.

## File Layout

```text
.blackhole/
  config.yaml
  models.yaml
  mcp.json
  prompts/
    system.md
    agent.md
  rules/
    coding-standard.md
    pr-check.md
```

## Runtime Merge Order

1. `data/config.json` provides app-wide defaults and user settings.
2. `.blackhole/config.yaml` selects the workspace agent profile, prompt files, rule files, and model config file.
3. `.blackhole/models.yaml` overlays active model, context size, token budget, temperature, and phase-specific model profiles.
4. `.blackhole/prompts/*.md` and `.blackhole/rules/*.md` are appended to the agent system prompt at runtime.
5. Derived workspace data is not persisted back into `data/config.json`.

## Rule Directives

Rule Markdown files are both human-readable prompt context and machine-readable PR check input.

Supported directives:

```md
- require-file: package.json
- require-script: test
- require-config: agent.profile
- forbid-path: src/**/*.bak
- forbid-text: "<<<<<<<"
```

Run the rule check directly:

```powershell
node scripts/check-workspace-rules.js
```

The PR check runs this rule check automatically:

```powershell
npm run pr:check
```

## UI Behavior

The settings modal exposes a read-only `Workspace` tab showing which config, model, rule, and prompt files were loaded. Editing remains file-based so project and team standards can be reviewed and versioned.
