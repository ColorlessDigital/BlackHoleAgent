#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BLACKHOLE_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"

NODE_VERSION="${NODE_VERSION:-24.22.2}"
LLAMA_CPP_REF="${LLAMA_CPP_REF:-b9553}"
UNAME_ARCH="$(uname -m)"
case "${UNAME_ARCH}" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported Linux architecture: ${UNAME_ARCH}" >&2; exit 1 ;;
esac

NODE_RUNTIME_DIR="${PROJECT_ROOT}/resources/node-runtime/linux-${NODE_ARCH}"
NODE_RUNTIME_CURRENT="${PROJECT_ROOT}/resources/node-runtime/current"
LLAMA_PLATFORM_DIR="${PROJECT_ROOT}/resources/llama.cpp/linux-${NODE_ARCH}"
LLAMA_SERVER_OUT="${LLAMA_PLATFORM_DIR}/llama-server"
LLAMA_CPP_SOURCE="${LLAMA_CPP_SOURCE:-${BLACKHOLE_ROOT}/.cache/llama.cpp}"
DOWNLOAD_CACHE="${BLACKHOLE_ROOT}/.cache/downloads"

mkdir -p "${NODE_RUNTIME_DIR}" "${LLAMA_PLATFORM_DIR}" "${DOWNLOAD_CACHE}"

if [[ "${SKIP_APT:-0}" != "1" ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    SUDO=""
    if [[ "${EUID}" -ne 0 ]]; then
      SUDO="sudo"
    fi
    ${SUDO} apt-get update
    GTK_PACKAGE=libgtk-3-0
    AUDIO_PACKAGE=libasound2
    FUSE_PACKAGE=libfuse2
    if apt-cache show libgtk-3-0t64 >/dev/null 2>&1; then GTK_PACKAGE=libgtk-3-0t64; fi
    if apt-cache show libasound2t64 >/dev/null 2>&1; then AUDIO_PACKAGE=libasound2t64; fi
    if apt-cache show libfuse2t64 >/dev/null 2>&1; then FUSE_PACKAGE=libfuse2t64; fi
    ${SUDO} apt-get install -y \
      ca-certificates \
      curl \
      git \
      build-essential \
      cmake \
      pkg-config \
      libssl-dev \
      "${GTK_PACKAGE}" \
      libnss3 \
      libgbm1 \
      "${AUDIO_PACKAGE}" \
      libsecret-1-0 \
      "${FUSE_PACKAGE}" \
      xvfb \
      dbus-x11 \
      zenity
  else
    echo "apt-get was not found. Skipping package installation." >&2
  fi
fi

if [[ ! -x "${NODE_RUNTIME_DIR}/bin/node" ]] || [[ "$("${NODE_RUNTIME_DIR}/bin/node" --version)" != "v${NODE_VERSION}" ]]; then
  NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
  NODE_TARBALL_PATH="${DOWNLOAD_CACHE}/${NODE_TARBALL}"
  echo "Downloading Node.js runtime: ${NODE_URL}"
  curl --fail --location --retry 3 "${NODE_URL}" -o "${NODE_TARBALL_PATH}"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${DOWNLOAD_CACHE}/SHASUMS256-${NODE_VERSION}.txt"
  (cd "${DOWNLOAD_CACHE}" && grep "  ${NODE_TARBALL}$" "SHASUMS256-${NODE_VERSION}.txt" | sha256sum --check --strict)
  [[ "${NODE_RUNTIME_DIR}" == "${PROJECT_ROOT}/resources/node-runtime/linux-${NODE_ARCH}" ]] || exit 1
  rm -rf "${NODE_RUNTIME_DIR}"
  mkdir -p "${NODE_RUNTIME_DIR}"
  tar -xJf "${NODE_TARBALL_PATH}" -C "${NODE_RUNTIME_DIR}" --strip-components=1
fi

if [[ -n "${LLAMA_SERVER_PATH:-}" ]]; then
  if [[ ! -x "${LLAMA_SERVER_PATH}" ]]; then
    echo "LLAMA_SERVER_PATH is not executable: ${LLAMA_SERVER_PATH}" >&2
    exit 1
  fi
  cp "${LLAMA_SERVER_PATH}" "${LLAMA_SERVER_OUT}"
else
  if [[ ! -d "${LLAMA_CPP_SOURCE}/.git" ]]; then
    mkdir -p "$(dirname "${LLAMA_CPP_SOURCE}")"
    git clone --depth=1 --branch "${LLAMA_CPP_REF}" https://github.com/ggml-org/llama.cpp "${LLAMA_CPP_SOURCE}"
  fi
  # Preserve an existing custom checkout; require the requested revision instead of pulling silently.
  EXPECTED_COMMIT="$(git -C "${LLAMA_CPP_SOURCE}" rev-parse "${LLAMA_CPP_REF}^{commit}")"
  [[ "$(git -C "${LLAMA_CPP_SOURCE}" rev-parse HEAD)" == "${EXPECTED_COMMIT}" ]] || {
    echo "llama.cpp checkout does not match ${LLAMA_CPP_REF}; choose a matching LLAMA_CPP_SOURCE/LLAMA_CPP_REF." >&2
    exit 1
  }

  BUILD_DIR="${LLAMA_CPP_SOURCE}/build-blackhole-linux-${NODE_ARCH}"
  CMAKE_ARGS=(
    -S "${LLAMA_CPP_SOURCE}"
    -B "${BUILD_DIR}"
    -DCMAKE_BUILD_TYPE=Release
    -DBUILD_SHARED_LIBS=OFF
    -DLLAMA_OPENSSL=ON
  )
  if command -v nvcc >/dev/null 2>&1; then
    CMAKE_ARGS+=(-DGGML_CUDA=ON)
  fi

  cmake "${CMAKE_ARGS[@]}"
  cmake --build "${BUILD_DIR}" --config Release --target llama-server -j "${BUILD_JOBS:-$(nproc)}"

  SERVER_CANDIDATES=(
    "${BUILD_DIR}/bin/llama-server"
    "${BUILD_DIR}/tools/server/llama-server"
    "${BUILD_DIR}/llama-server"
  )
  SERVER_BUILT=""
  for candidate in "${SERVER_CANDIDATES[@]}"; do
    if [[ -x "${candidate}" ]]; then
      SERVER_BUILT="${candidate}"
      break
    fi
  done
  if [[ -z "${SERVER_BUILT}" ]]; then
    echo "Built llama-server was not found under ${BUILD_DIR}" >&2
    exit 1
  fi
  cp "${SERVER_BUILT}" "${LLAMA_SERVER_OUT}"
fi

chmod +x "${LLAMA_SERVER_OUT}"
"${LLAMA_SERVER_OUT}" --version
if ldd "${LLAMA_SERVER_OUT}" 2>&1 | grep -q 'not found'; then
  echo "llama-server has missing shared libraries." >&2
  exit 1
fi
"${NODE_RUNTIME_DIR}/bin/node" "${PROJECT_ROOT}/scripts/prepare-platform-runtime.js" --platform=linux --arch="${NODE_ARCH}"

echo "Kali runtime is ready."
echo "Node runtime: ${NODE_RUNTIME_CURRENT}"
echo "llama-server: ${LLAMA_SERVER_OUT}"
