# BlackHole Frontend

React 19 and TypeScript UI, built with Vite 8. This is the desktop agent frontend,
not a standalone cloud service.

Install from the repository bootstrap, then use:

```powershell
npm --prefix blackhole/frontend test
npm --prefix blackhole/frontend run lint
npm --prefix blackhole/frontend run typecheck
npm --prefix blackhole/frontend run build
```

For development, start the BlackHole backend and use the existing API/session
bootstrap. Production assets are packaged into Electron.

The interface shows agent/tool state, verification, separate reasoning records
and checkpoint recovery. A source change can remain incomplete when behavioral
checks are unavailable; that is distinct from a failed assertion or provider error.

Public screenshots use the real frontend with scripted API/SSE inputs:
[image provenance](../../docs/images/README.md). No real user session is required.
Visible extension-host E2E and clean-PC installation are separate from headless UI checks.
