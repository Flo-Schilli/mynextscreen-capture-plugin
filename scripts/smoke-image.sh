#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Smoke test of the built image. Usage: scripts/smoke-image.sh <image>
#
# Checks: the plugin starts and reports license_required, FFmpeg has the
# expected encoders, the image carries exactly the pinned libndi.so.6 and no SDK
# headers or docs, the acceptance paths work, and grandi loads only after the
# license was accepted.
set -euo pipefail

image="${1:?usage: smoke-image.sh <image>}"
manifest="$(dirname "$0")/../ndi-runtime.json"
manifest_value() { node -p "require('$manifest').$1"; }
expected_lib_sha="$(manifest_value libndiSha256)"
expected_license_sha="$(manifest_value licenseSha256)"

# start_plugin runs in a command substitution, so containers are found by label.
cleanup() {
  docker ps -aq --filter label=mns-capture-smoke=1 | xargs -r docker rm -f >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

fail() { echo "::error::$*"; exit 1; }

# GET/PUT/DELETE over the plugin's unix socket, from inside the container.
api() {
  local container="$1" method="$2" path="$3" body="${4:-}"
  docker exec "$container" node -e '
    const http = require("node:http");
    const [method, path, body] = process.argv.slice(1);
    const req = http.request(
      { socketPath: "/run/mns-capture/plugin.sock", method, path, headers: { "content-type": "application/json" } },
      (res) => { let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => console.log(res.statusCode + " " + text)); },
    );
    req.on("error", (e) => { console.error(e.message); process.exit(1); });
    req.end(body);
  ' "$method" "$path" "$body"
}

field() { node -e 'const j = JSON.parse(process.argv[1].replace(/^\d+ /, "")); const v = process.argv[2].split(".").reduce((o, k) => o?.[k], j); console.log(v ?? "null")' "$1" "$2"; }

start_plugin() {
  local name="$1"; shift
  # Read-only rootfs with tmpfs for the three private directories: the same
  # shape as the production container.
  docker run -d --name "$name" --label mns-capture-smoke=1 --user 1000:1000 --read-only --tmpfs /tmp \
    --tmpfs /run/mns-capture:uid=1000,gid=1000,mode=0700 \
    --tmpfs /var/lib/mns-capture/state:uid=1000,gid=1000,mode=0700 \
    --tmpfs /var/lib/mns-capture/hls:uid=1000,gid=1000,mode=0700 \
    "$@" "$image" >/dev/null
  for _ in $(seq 1 30); do
    if reply="$(api "$name" GET /v1/status 2>/dev/null)" && [ "${reply%% *}" = 200 ]; then
      echo "$reply"
      return 0
    fi
    sleep 1
  done
  docker logs "$name" || true
  fail "plugin $name did not answer GET /v1/status"
}

echo "== plugin starts and requires the license"
reply="$(start_plugin smoke-plain)"
[ "$(field "$reply" state)" = license_required ] || fail "expected license_required, got: $reply"
[ "$(field "$reply" license.licenseSha256)" = "$expected_license_sha" ] \
  || fail "reported license hash differs from ndi-runtime.json: $reply"
[ "$(field "$reply" arch)" = x64 ] || fail "expected arch x64: $reply"
docker logs smoke-plain 2>&1 | grep -q "NDI runtime loaded" && fail "grandi was loaded before the license was accepted"

echo "== a stream is refused before acceptance"
reply="$(api smoke-plain PUT /v1/streams/6f1c2a52-7d3e-4c1a-9f0e-2b8d5a1c9e11 \
  '{"cameraHost":"127.0.0.1","ndiSourceName":null,"bandwidth":"highest","width":1280,"height":720,"fps":30,"bitrateKbps":3000,"encoderPref":"software"}')"
[ "${reply%% *}" = 409 ] || fail "expected 409 before acceptance, got: $reply"

echo "== a wrong hash is refused"
reply="$(api smoke-plain PUT /v1/license "{\"sdkVersion\":\"$(manifest_value sdkVersion)\",\"licenseSha256\":\"$(printf '0%.0s' $(seq 1 64))\"}")"
[ "${reply%% *}" = 409 ] || fail "expected 409 for a wrong hash, got: $reply"

echo "== acceptance through the API loads grandi"
reply="$(api smoke-plain PUT /v1/license "{\"sdkVersion\":\"$(manifest_value sdkVersion)\",\"licenseSha256\":\"$expected_license_sha\"}")"
[ "$(field "$reply" state)" = ready ] || fail "expected ready after acceptance, got: $reply"
docker logs smoke-plain 2>&1 | grep -q "NDI runtime loaded" || fail "grandi did not load after acceptance"

echo "== acceptance through the environment loads grandi at start"
reply="$(start_plugin smoke-env -e "MNS_CAPTURE_ACCEPT_NDI_LICENSE=$expected_license_sha")"
[ "$(field "$reply" state)" = ready ] || fail "expected ready with env acceptance, got: $reply"
[ "$(field "$reply" acceptance.via)" = env ] || fail "expected acceptance via env: $reply"

echo "== a bare 'true' in the environment is not an acceptance"
reply="$(start_plugin smoke-true -e MNS_CAPTURE_ACCEPT_NDI_LICENSE=true)"
[ "$(field "$reply" state)" = license_required ] || fail "'true' must not accept the license: $reply"

echo "== ffmpeg encoders"
encoders="$(docker run --rm --entrypoint ffmpeg "$image" -hide_banner -encoders)"
for encoder in libx264 h264_vaapi; do
  grep -qw "$encoder" <<<"$encoders" || fail "ffmpeg encoder $encoder missing"
  echo "ffmpeg encoder ok: $encoder"
done

echo "== NDI files in the image"
files="$(docker run --rm --entrypoint sh "$image" -c \
  'find / -xdev \( -iname "libndi*" -o -iname "Processing.NDI*" -o -iname "*NDI SDK*" -o -iname "Install_NDI*" -o -iname "NDIlib*" \) 2>/dev/null | sort')"
expected_files="/app/node_modules/@grandi/linux-x64/libndi.so.6
/app/node_modules/@grandi/linux-x64/libndi_licenses.txt
/usr/share/licenses/capture-plugin/libndi_licenses.txt"
[ "$files" = "$expected_files" ] || fail "unexpected NDI files in the image:
$files"
lib_sha="$(docker run --rm --entrypoint sha256sum "$image" /app/node_modules/@grandi/linux-x64/libndi.so.6 | cut -d' ' -f1)"
[ "$lib_sha" = "$expected_lib_sha" ] || fail "libndi.so.6 sha256 $lib_sha differs from ndi-runtime.json ($expected_lib_sha)"
headers="$(docker run --rm --entrypoint sh "$image" -c 'find /app/node_modules/@grandi /app/node_modules/grandi \( -name "*.h" -o -name "*.hpp" -o -name "*.pdf" \) 2>/dev/null || true')"
[ -z "$headers" ] || fail "NDI headers or docs in the image: $headers"
docker run --rm --entrypoint sh "$image" -c \
  'ls /usr/share/licenses/capture-plugin/NOTICE /usr/share/licenses/capture-plugin/NDI-SDK-License-Agreement.txt /usr/share/licenses/ffmpeg/SOURCE' >/dev/null \
  || fail "license files are missing"
echo "libndi.so.6 sha256 ok: $lib_sha"

echo "Smoke test passed."
