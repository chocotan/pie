#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]:-}" == */update.sh && -f "${BASH_SOURCE[0]%/*}/install-pie.mjs" ]]; then
  exec node "${BASH_SOURCE[0]%/*}/install-pie.mjs" --update "$@"
fi

command -v node >/dev/null || { printf 'Pie requires Node.js >=22.19.0.\n' >&2; exit 1; }
installer_dir="$(mktemp -d "${TMPDIR:-/tmp}/pie-update.XXXXXXXX")"
trap 'rm -rf "$installer_dir"' EXIT
curl --fail --silent --show-error --location \
  https://raw.githubusercontent.com/chocotan/pie/main/scripts/install-pie.mjs \
  --output "$installer_dir/install-pie.mjs"
node "$installer_dir/install-pie.mjs" --update "$@"
