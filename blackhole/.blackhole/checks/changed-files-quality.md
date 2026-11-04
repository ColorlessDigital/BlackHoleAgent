# Changed Files Quality

Changed source files must not contain obvious merge or focused-test leftovers.

- level: must-pass
- changed-only: true
- applies-to: src/**/*, scripts/**/*, frontend/src/**/*
- forbid-text: <<<<<<<
- forbid-text: =======
- forbid-text: >>>>>>>
- forbid-text: .only(
- require-file: .blackhole/config.yaml
- require-script: npm run check:backend
