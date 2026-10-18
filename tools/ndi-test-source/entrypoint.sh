#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Starts mDNS (D-Bus + avahi) inside the container unless START_AVAHI=0, then runs the sender.
# With START_AVAHI=0 the host's avahi is used via a bind-mounted D-Bus socket:
#   -v /run/dbus/system_bus_socket:/run/dbus/system_bus_socket
set -eu

if [ "${START_AVAHI:-1}" = "1" ]; then
  mkdir -p /run/dbus
  rm -f /run/dbus/pid
  dbus-daemon --system --fork
  avahi-daemon --daemonize --no-drop-root --no-rlimits
  echo "[entrypoint] dbus + avahi-daemon started in container"
else
  if [ ! -S /run/dbus/system_bus_socket ]; then
    echo "[entrypoint] START_AVAHI=0 but /run/dbus/system_bus_socket is missing (mount the host socket)" >&2
    exit 1
  fi
  echo "[entrypoint] using host avahi via mounted D-Bus socket"
fi

exec node /app/sender.mjs "$@"
