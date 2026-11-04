# Third-Party Components

The Apache-2.0 grant covers BlackHole-owned material, not third-party works.
The source ZIP does not bundle installed npm packages, Electron/Node/llama.cpp
binaries or model weights. Reinstall dependencies with the committed lockfiles
and retain their license and notice files when redistributing a built product.

`THIRD_PARTY_PACKAGES.json` in the public export records exact versions, SPDX
license metadata, integrity values and package locations from all three npm
lockfiles. It is an inventory, not a substitute for upstream license texts or
a complete binary redistribution compliance audit. Platform-specific optional
packages may not be installed on the current machine.

Key upstream projects:

- [Electron](https://github.com/electron/electron): MIT; its distribution also
  carries Chromium and other third-party licenses.
- [Node.js](https://github.com/nodejs/node): Node's LICENSE includes its own MIT
  license and bundled dependency notices; retain the distribution's files.
- [llama.cpp](https://github.com/ggml-org/llama.cpp): MIT; retain all license
  files supplied in downloaded runtime packages, including GPU components.
- [React](https://github.com/facebook/react): MIT. The React logo asset under
  `blackhole/frontend/src/assets` is an upstream mark, not a BlackHole mark.
- [Vite](https://github.com/vitejs/vite): MIT. Its logo/template assets remain
  upstream assets and marks; see the accompanying upstream license copies.
- Express, Cheerio, TypeScript, Playwright, ESLint and extension build tools
  retain their own package licenses. See the lockfile inventory.

React and Vite license copies for the included template assets are under
`third-party-licenses`. Other BlackHole image assets are included as project
assets; their provenance has not been independently established by this export.
Confirm rights to those assets before publishing under a different brand.

GGUF models are downloaded separately and may impose independent model-license
conditions. OpenCode Go and other services have independent terms; their names
do not imply affiliation or endorsement.
