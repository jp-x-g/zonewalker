#!/usr/bin/env bash
# Download and validate a point-in-time backup of the live Zonewalker data.

set -euo pipefail
umask 077

config_file="${ZONEWALKER_BACKUP_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/zonewalker-backup/curl.conf}"
backup_dir="${ZONEWALKER_BACKUP_DIR:-$HOME/backups/zonewalker}"

if [[ ! -r "$config_file" ]]; then
    printf 'Zonewalker backup config is not readable: %s\n' "$config_file" >&2
    exit 1
fi

mkdir -p "$backup_dir"
timestamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
destination="$backup_dir/posting-foundation-zonewalker-$timestamp.zip"
temporary="$(mktemp "$backup_dir/.zonewalker-backup.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT

curl --config "$config_file" --output "$temporary"

# A transport success is not enough: reject truncated/non-ZIP downloads and
# archives that do not contain the core editable data plus at least one layer.
unzip -tq "$temporary" >/dev/null
archive_entries="$(unzip -Z1 "$temporary")"
if ! grep -qx 'data/schemas.json' <<<"$archive_entries"; then
    printf 'Downloaded archive is missing data/schemas.json\n' >&2
    exit 1
fi
if ! grep -Eq '^data/overlay_[^/]+\.json$' <<<"$archive_entries"; then
    printf 'Downloaded archive does not contain any editable layers\n' >&2
    exit 1
fi

mv -- "$temporary" "$destination"
trap - EXIT
printf 'Saved validated Zonewalker backup: %s\n' "$destination"
