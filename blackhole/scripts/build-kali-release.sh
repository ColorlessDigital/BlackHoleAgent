#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BLACKHOLE_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"
EXTENSION_ROOT="$(cd "${PROJECT_ROOT}/../vscode-blackhole" && pwd)"
cd "${PROJECT_ROOT}"

bash "${PROJECT_ROOT}/scripts/setup-kali-runtime.sh"
export PATH="${PROJECT_ROOT}/resources/node-runtime/current/bin:${PATH}"

install_node_deps() {
  local target="$1"
  if [[ -f "${target}/package-lock.json" ]]; then
    npm --prefix "${target}" ci
  else
    npm --prefix "${target}" install
  fi
}

install_node_deps "${PROJECT_ROOT}"
install_node_deps "${PROJECT_ROOT}/frontend"
install_node_deps "${EXTENSION_ROOT}"
for target in "${PROJECT_ROOT}" "${PROJECT_ROOT}/frontend" "${EXTENSION_ROOT}"; do
  npm --prefix "${target}" audit --audit-level=high
done

node node_modules/playwright/cli.js install chromium --only-shell
npm --prefix "${PROJECT_ROOT}" run release:check:kali
npm exec -- electron-builder --config build/linux.cjs --linux AppImage deb tar.gz
if [[ -n "${DISPLAY:-}" ]]; then
  node scripts/smoke-packaged-app.js --exe="${PROJECT_ROOT}/dist/linux-unpacked/blackhole"
else
  xvfb-run -a dbus-run-session -- node scripts/smoke-packaged-app.js --exe="${PROJECT_ROOT}/dist/linux-unpacked/blackhole"
fi

node scripts/write-build-info.js --platform=linux --output="${PROJECT_ROOT}/dist/BUILDINFO.json"

# Sync to repo linux/ folder (parity with windows/ sync on Windows builds).
LINUX_RELEASE_DIR="${BLACKHOLE_ROOT}/linux"
mkdir -p "${LINUX_RELEASE_DIR}"
shopt -s nullglob
for pattern in '*.AppImage' '*.deb' '*.tar.gz'; do
  artifacts=("${PROJECT_ROOT}"/dist/${pattern})
  ((${#artifacts[@]} > 0)) || { echo "Missing release artifact: ${pattern}" >&2; exit 1; }
  cp -f "${artifacts[@]}" "${LINUX_RELEASE_DIR}/"
done
cp -f "${PROJECT_ROOT}/dist/BUILDINFO.json" "${LINUX_RELEASE_DIR}/BUILDINFO.json"
echo "Kali release artifacts are available in ${PROJECT_ROOT}/dist and synced to ${LINUX_RELEASE_DIR}/"
