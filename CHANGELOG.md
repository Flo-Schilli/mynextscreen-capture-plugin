# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The control API is versioned
separately (`/v1`, `apiVersion` in `GET /v1/status`).

## [Unreleased]

## [0.1.0] - 2026-10-18

### Added

- NDI receive pipeline: finder with extra IPs, bounded drop-oldest queue, FFmpeg transcoder to Short-HLS with per-run segment names, no upscaling, encoder selection (`libx264`, `h264_vaapi`).
- Control API on a unix socket: status, license acceptance and revocation, license text, stream start, replace and stop, stream list. Contract in `openapi.json`, checked against the handlers by the specs.
- License gate: `license_required`, `ready`, `error`, `incompatible`. Acceptance by `PUT /v1/license` or `MNS_CAPTURE_ACCEPT_NDI_LICENSE`, bound to the SHA-256 of the shipped NDI license text and persisted in the state directory. grandi is not loaded before acceptance.
- Platform check: x86-64 only, other architectures need `MNS_CAPTURE_DEV_ALLOW_ARM=1`.
- At most `MNS_CAPTURE_MAX_STREAMS` (default 8) streams at once; a new id beyond that gets 409 `stream_limit`.
- The gate is bound to the runtime that loads: `libndi.so.6` is hashed against `ndi-runtime.json` at start (`runtime_mismatch`), grandi must report exactly the pinned SDK version, and `MNS_CAPTURE_RUNTIME_DIR` is honored only with `MNS_CAPTURE_DEV_ALLOW_ARM=1`.
- An acceptance covers the NDI license text and the plugin terms (`NOTICE`); a change of either returns the plugin to `license_required`. Status reports `ndiLicenseSha256`, `termsSha256` and the combined `licenseSha256`.
- GPL source offer in `NOTICE`; exact libx264 and Avahi package versions with their source packages are written into `/usr/share/licenses/ffmpeg/SOURCE` at build time.
- Shutdown: aborts the wait for an NDI source and exits after 8 s at the latest. The socket is created with umask 077, and a socket that still answers is never taken over.
- amd64 container image with the unmodified `libndi.so.6` from `@grandi/linux-x64`, a minimal GPL FFmpeg build, license texts and `NOTICE` under `/usr/share/licenses/`.
- CI: lint, format, typecheck, tests with coverage gate, dependency audit, gitleaks, NDI SDK denylist, image smoke test, Trivy gate, CodeQL, GHCR publish (amd64) on version tags only. The published image is the one that was smoke-tested and scanned. Weekly NDI SDK watch and Dependabot.
- Development tools `tools/ndi-test-source` (fake NDI camera) and `tools/ndi-spike` (receive and encode benchmark).

[Unreleased]: https://github.com/Flo-Schilli/mynextscreen-capture-plugin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Flo-Schilli/mynextscreen-capture-plugin/releases/tag/v0.1.0
