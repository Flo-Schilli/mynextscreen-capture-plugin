# SPDX-License-Identifier: Apache-2.0
# NDI test source (fake camera) — standalone dev tool image, NOT part of the root workspace.
# Build context: tools/ndi-test-source (of the mynextscreen-capture-plugin repository)
#   docker build -t mns-ndi-test-source tools/ndi-test-source
#
# trixie, not bookworm: the grandi x64 binary needs GLIBCXX_3.4.31 (libstdc++ >= 13).
FROM node:26-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libavahi-client3 libavahi-common3 avahi-daemon dbus ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Own minimal package.json + lockfile (only grandi); the root package-lock.json is not involved.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY sender.mjs entrypoint.sh ./

ENV NDI_NAME=TEST-CAM \
    WIDTH=1280 \
    HEIGHT=720 \
    FPS=30 \
    START_AVAHI=1

ENTRYPOINT ["/app/entrypoint.sh"]
