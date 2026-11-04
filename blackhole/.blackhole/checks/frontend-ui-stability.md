# Frontend UI Stability

Frontend changes should stay readable, avoid debug leftovers, and keep visual checks part of the release path.

- level: warning
- changed-only: true
- applies-to: frontend/src/**/*, frontend/index.html
- warn-text: console.log(
- warn-text: debugger
- warn-text: TODO
- require-script: npm run build:frontend
- require-script: npm run visual:frontend
