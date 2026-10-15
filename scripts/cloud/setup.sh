#!/usr/bin/env bash
# Bootstrap a Linux x64 development environment; never launch the application.
set -euo pipefail
repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repository"
if [[ "$(uname -s)-$(uname -m)" != Linux-x86_64 ]]; then
  printf '%s\n' 'This development environment requires Linux x64.' >&2
  exit 1
fi
export PROJECT_MIND_ENV_DIR="${PROJECT_MIND_ENV_DIR:-$repository/../project-mind-env}"
mkdir -p "$PROJECT_MIND_ENV_DIR"
PROJECT_MIND_ENV_DIR="$(cd "$PROJECT_MIND_ENV_DIR" && pwd)"
ca_bundle="${PROJECT_MIND_CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
container="${PROJECT_MIND_DEV_CONTAINER:-project-mind-dev}"
docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
    -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
docker info >/dev/null
if docker container inspect "$container" >/dev/null 2>&1; then
  printf 'Container %s already exists. Reuse it, or inspect and remove it before recreating.\n' "$container" >&2
  exit 1
fi
test -f "$ca_bundle"
archive="$PROJECT_MIND_ENV_DIR/node-v24.21.0-linux-x64.tar.gz"
if [[ ! -f "$archive" ]]; then
  curl -fsSL https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz -o "$archive.download"
  mv "$archive.download" "$archive"
fi
# The existing prepare script validates the archive against the committed hash.
node packages/agent-host/scripts/prepare-runtime.mjs linux-x64 "$archive"
tar -xzf "$archive" -C "$PROJECT_MIND_ENV_DIR"
export PATH="$PROJECT_MIND_ENV_DIR/node-v24.21.0-linux-x64/bin:$PATH"
npm ci --no-audit --no-fund
npm --prefix packages/agent-host ci --no-audit --no-fund
# Do not overlap staging or tests that validate these resources.
npm run build:record-worker
npm run stage:record-runtime
npm run build:source-worker
npm run stage:source-runtime
# sherpa's build-script HTTP client does not load the injected system CA.
# Use its supported local-archive input with a verified upstream release asset.
mkdir -p "$PROJECT_MIND_ENV_DIR/native-archives"
sherpa_archive="$PROJECT_MIND_ENV_DIR/native-archives/sherpa-onnx-v1.13.8-linux-x64-static-lib.tar.bz2"
if [[ ! -f "$sherpa_archive" ]]; then
  curl -fsSL https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-static-lib.tar.bz2 \
    -o "$sherpa_archive.download"
  mv "$sherpa_archive.download" "$sherpa_archive"
fi
printf '%s  %s\n' e1fdc5b67530e15741ef897fa5ffff297056f3bf0c6d829a27af9225a4c4b5a6 "$sherpa_archive" | sha256sum -c -
docker build --secret "id=proxy_ca,src=$ca_bundle" \
  -f scripts/cloud/Dockerfile -t project-mind-dev:bookworm .
docker run -d --name "$container" --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$repository,dst=/workspace/project_mind" \
  --mount "type=bind,src=$PROJECT_MIND_ENV_DIR,dst=/workspace/project-mind-env" \
  --mount "type=bind,src=$ca_bundle,dst=/run/proxy-ca.pem,readonly" \
  -e CARGO_HOME=/workspace/project-mind-env/cargo-home \
  -e RUSTUP_HOME=/usr/local/rustup \
  -e CARGO_HTTP_CAINFO=/run/proxy-ca.pem \
  -e SSL_CERT_FILE=/run/proxy-ca.pem -e CURL_CA_BUNDLE=/run/proxy-ca.pem \
  -e NODE_EXTRA_CA_CERTS=/run/proxy-ca.pem \
  -e PATH=/workspace/project-mind-env/node-v24.21.0-linux-x64/bin:/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  project-mind-dev:bookworm sleep infinity
