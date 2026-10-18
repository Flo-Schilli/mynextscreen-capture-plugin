# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). The control API is versioned
separately (`/v1`, `apiVersion` in `GET /v1/status`).

## [Unreleased]

### Added

- NDI receive pipeline: finder with extra IPs, bounded drop-oldest queue, FFmpeg transcoder to Short-HLS with per-run segment names, no upscaling, encoder selection (`libx264`, `h264_vaapi`).
- Control API on a unix socket: status, license acceptance and revocation, license text, stream start, replace and stop, stream list. Contract in `openapi.json`, checked against the handlers by the specs.
- License gate: `license_required`, `ready`, `error`, `incompatible`. Acceptance by `PUT /v1/license` or `MNS_CAPTURE_ACCEPT_NDI_LICENSE`, bound to the SHA-256 of the shipped NDI license text and persisted in the state directory. grandi is not loaded before acceptance.
- Platform check: x86-64 only, other architectures need `MNS_CAPTURE_DEV_ALLOW_ARM=1`.
- amd64 container image with the unmodified `libndi.so.6` from `@grandi/linux-x64`, a minimal GPL FFmpeg build, license texts and `NOTICE` under `/usr/share/licenses/`.
- CI: lint, format, typecheck, tests with coverage gate, dependency audit, gitleaks, NDI SDK denylist, image smoke test, Trivy gate, CodeQL, GHCR publish (amd64) on `main` and version tags. Weekly NDI SDK watch and Dependabot.
- Development tools `tools/ndi-test-source` (fake NDI camera) and `tools/ndi-spike` (receive and encode benchmark).
