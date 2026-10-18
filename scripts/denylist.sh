#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Fails when NDI SDK material is part of the repository tree or of a pull
# request's commits. The SDK, its headers and documentation are Confidential
# Information under clause 3a of the NDI SDK License Agreement and must never be
# committed. The only NDI binary that reaches the image is the libndi.so.6 that
# comes with the @grandi/linux-x64 npm package, installed at build time.
#
# Usage: scripts/denylist.sh [<base-ref>]
#   Without an argument only the tracked tree is checked. With a base ref every
#   file touched by a commit in <base-ref>..HEAD is checked too, so a file that
#   was added and removed again within the same pull request is still caught.
set -euo pipefail

# Path patterns (case-insensitive, extended regex), matched against the full path.
path_patterns=(
  '(^|/)libndi'                 # libndi.so, libndi.so.6, libndi_licenses.txt, ...
  '(^|/)Processing\.NDI[^/]*'   # SDK headers
  'NDI.{0,4}SDK'                # "NDI SDK", "NDI 6 SDK", NDI_SDK, ndi-sdk directories and archives
  '(^|/)Install_NDI'            # SDK installers and archives
  '(^|/)NDIlib[^/]*\.(h|lib|dll|so|a)$'
)

# Content patterns for text files: symbols that only occur in SDK headers.
content_pattern='NDIlib_[a-z_]+_t\b|Processing\.NDI\.Lib\.h'

status=0
report() {
  echo "::error::NDI SDK material found ($1): $2"
  status=1
}

check_paths() {
  local label="$1"
  local file pattern
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    for pattern in "${path_patterns[@]}"; do
      if printf '%s\n' "$file" | grep -Eiq -e "$pattern"; then
        report "$label" "$file"
        break
      fi
    done
  done
}

check_paths "tree" < <(git ls-files)

if git grep -Iliq -E -e "$content_pattern" -- . ':!scripts/denylist.sh'; then
  while IFS= read -r file; do
    report "tree content" "$file"
  done < <(git grep -Ili -E -e "$content_pattern" -- . ':!scripts/denylist.sh')
fi

if [ "$#" -ge 1 ]; then
  base="$1"
  check_paths "pull request commits" < <(git log --format= --name-only --diff-filter=AMRC "${base}..HEAD" | sort -u)
fi

if [ "$status" -eq 0 ]; then
  echo "No NDI SDK material found."
fi
exit "$status"
