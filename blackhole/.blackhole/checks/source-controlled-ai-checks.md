# Source Controlled AI Checks

PR checks are declared in repository files so teams can review, tune, and version the agent quality gates.

- level: must-pass
- changed-only: false
- applies-to: .blackhole/checks/*.md
- require-file: .blackhole/checks/changed-files-quality.md
- require-file: .blackhole/checks/agent-platform-regression.md
- require-file: .blackhole/checks/frontend-ui-stability.md
- require-script: npm run pr:check -- --skip-vsix
