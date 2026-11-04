# PR Check Rule

Every release-facing change must keep the local quality gate runnable from a single command.

Required checks:

- backend syntax validation
- backend unit tests
- workspace rule check
- E2E corpus shape check
- VS Code bridge check
- VSIX packaging check

Machine-readable PR directives:

- require-script: test
- require-script: check:backend
- require-script: check:workspace-rules
- require-script: pr:check
- require-script: package:vscode-extension
- require-config: workspace.name
- require-config: agent.profile
