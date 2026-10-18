# SPDX-License-Identifier: Apache-2.0
# mynextscreen capture plugin: amd64 production image.
#
#   docker build -t mns-capture-plugin:dev .
#
# Supported platform: x86-64 general-purpose Linux. An arm64 image can be built
# locally for development tests (together with MNS_CAPTURE_DEV_ALLOW_ARM=1 at
# run time). It is never published.
#
# Debian trixie (glibc), not Alpine: the NDI bindings (`grandi`) ship prebuilt
# glibc binaries only, and the x64 `grandi.node` needs GLIBCXX_3.4.31, which
# bookworm's libstdc++ does not provide.

# Stage 1: Minimal FFmpeg
# Built from source with only what the capture pipeline uses (raw UYVY on a
# pipe, scale/fps/format/hwupload, libx264 + h264_vaapi, HLS/MPEG-TS output to
# files). h264_v4l2m2m stays in the build for internal arm64 development tests;
# it is not a supported production path. Debian's ffmpeg package adds ~200 MB
# compressed and a long tail of demuxer/decoder/protocol CVEs the plugin can
# never reach. Keep the component list in sync with src/pipeline/ndi-ffmpeg-args.ts
# and src/pipeline/ndi-encoder.ts. Same base as the runtime so the glibc matches.
#
# Bump: take the new 7.1.x tarball from https://ffmpeg.org/releases/, update
# FFMPEG_VERSION, and set FFMPEG_SHA256 from `sha256sum ffmpeg-<version>.tar.xz`
# (or the .asc signature check). Trivy cannot see this build, so follow
# FFmpeg security releases manually.
FROM node:26-trixie-slim AS ffmpeg-builder

ARG FFMPEG_VERSION=7.1.5
ARG FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential pkg-config nasm ca-certificates curl xz-utils \
       libx264-dev libva-dev libdrm-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
    && tar xJf ffmpeg.tar.xz --strip-components=1 \
    && rm ffmpeg.tar.xz

# h264_v4l2m2m only exists on Linux with the V4L2 headers (linux-libc-dev);
# configure fails loudly if a requested component cannot be built.
RUN ./configure \
      --prefix=/usr/local \
      --disable-everything --disable-autodetect --disable-doc --disable-debug \
      --disable-network --disable-ffplay --disable-ffprobe \
      --enable-gpl --enable-libx264 --enable-vaapi --enable-libdrm \
      --enable-v4l2-m2m \
      --enable-protocol=pipe,file \
      --enable-demuxer=rawvideo \
      --enable-decoder=rawvideo \
      --enable-filter=scale,fps,format,hwupload,null,anull \
      --enable-muxer=hls,mpegts \
      --enable-encoder=libx264,h264_vaapi,h264_v4l2m2m \
      --enable-parser=h264 \
      --enable-bsf=h264_mp4toannexb,null \
    && make -j"$(nproc)" \
    && make install \
    && strip /usr/local/bin/ffmpeg \
    && install -d /licenses \
    && cp COPYING.GPLv2 COPYING.GPLv3 LICENSE.md /licenses/ \
    && printf '%s\n' \
       "FFmpeg ${FFMPEG_VERSION} (GPL, built with libx264)" \
       "Source: https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
       "SHA-256: ${FFMPEG_SHA256}" \
       "Build recipe: Dockerfile (stage ffmpeg-builder) in https://github.com/Flo-Schilli/mynextscreen-capture-plugin" \
       "Configure line: $(sed -n 's/^#define FFMPEG_CONFIGURATION "\(.*\)"$/\1/p' config.h)" \
       > /licenses/SOURCE

# Stage 2: Build the TypeScript sources
FROM node:26-trixie-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# The lockfile is maintained with the npm version pinned in package.json; the
# base image's bundled npm can lag that patch, so pin it explicitly.
RUN npm i -g npm@12.2.0
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

# Stage 3: Production runtime
FROM node:26-trixie-slim

# Pull the current Debian package set: the base image tag is rebuilt less often
# than its packages are fixed, and the CI image scan gates on exactly these.
# CI passes the build date, so the layer is re-resolved daily instead of being
# replayed from the buildx cache.
#
# tini as PID 1 for clean signal handling.
# libx264-164, libva2, libva-drm2, libdrm2: runtime libraries of the minimal
# ffmpeg from stage 1. No VA driver is installed: h264_vaapi works only when the
# host provides one, otherwise the plugin falls back to libx264.
# libavahi-client3 + libavahi-common3: libndi links against the Avahi client
# API. No avahi-daemon and no D-Bus run in the container: sources are found by
# address (extraIPs), not by mDNS.
ARG PACKAGE_REFRESH=unset
RUN echo "debian package refresh: ${PACKAGE_REFRESH}" \
    && apt-get update \
    && apt-get -y upgrade \
    && apt-get install -y --no-install-recommends \
       tini libx264-164 libva2 libva-drm2 libdrm2 libavahi-client3 libavahi-common3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /licenses /usr/share/licenses/ffmpeg
# Exact versions of the Debian packages that carry GPL/LGPL code in this image
# (libx264 is linked into FFmpeg, the Avahi client libraries into libndi's
# dependencies), with their source packages. Written at build time, so the
# list always matches what was installed.
RUN { \
      echo; \
      echo "Debian packages in this image with GPL/LGPL code (binary package, version, source package):"; \
      dpkg-query -W -f='${Package} ${Version} (source: ${source:Package} ${source:Version})\n' \
        libx264-164 libavahi-client3 libavahi-common3; \
      echo "Source: https://sources.debian.org/src/<source package>/<source version>/"; \
      echo "        or: apt-get source <source package>=<source version> (Debian trixie)"; \
    } >> /usr/share/licenses/ffmpeg/SOURCE

WORKDIR /app

COPY package.json package-lock.json ./
# npm is a build-time tool only: the container runs `node dist/main.js`.
# Removing it drops the advisories Trivy reports against npm's own bundled
# dependencies.
#
# Never `--omit=optional`: the NDI runtime (grandi.node + libndi.so.6) and its
# license files (LICENSE, libndi_licenses.txt) arrive as the per-architecture
# optional dependency @grandi/linux-<arch>.
RUN npm i -g npm@12.2.0 \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The runtime keeps exactly one libndi file: libndi.so.6, unmodified, next to
# grandi.node so that its $ORIGIN runpath finds it. The package also ships an
# identical copy named libndi.so (a development link name that nothing loads).
#
# License texts (NDI SDK License Agreement, libndi_licenses.txt, plugin NOTICE,
# Apache-2.0) go to /usr/share/licenses/capture-plugin/. The plugin reads the
# NDI license text from the package directory at run time.
COPY LICENSE NOTICE /usr/share/licenses/capture-plugin/
RUN set -eu; \
    runtime="$(ls -d node_modules/@grandi/linux-*)"; \
    rm -f "${runtime}/libndi.so"; \
    cp "${runtime}/LICENSE" /usr/share/licenses/capture-plugin/NDI-SDK-License-Agreement.txt; \
    cp "${runtime}/libndi_licenses.txt" /usr/share/licenses/capture-plugin/libndi_licenses.txt; \
    mv /usr/share/licenses/capture-plugin/LICENSE /usr/share/licenses/capture-plugin/LICENSE-Apache-2.0

COPY ndi-runtime.json ./
COPY --from=builder --chown=node:node /app/dist ./dist

ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_DATE=${BUILD_DATE}
LABEL org.opencontainers.image.title="mynextscreen-capture-plugin" \
      org.opencontainers.image.description="NDI-compatible capture plugin for mynextscreen site agents" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/Flo-Schilli/mynextscreen-capture-plugin" \
      org.opencontainers.image.licenses="Apache-2.0 AND GPL-2.0-or-later AND LicenseRef-NDI-SDK"

# Socket, state (license acceptance) and HLS output. All private to the user the
# plugin runs as; in production they are bind-mounted from the host and shared
# with the site agent, which runs as the same uid.
RUN install -d -o node -g node -m 700 \
      /run/mns-capture \
      /var/lib/mns-capture \
      /var/lib/mns-capture/state \
      /var/lib/mns-capture/hls

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
