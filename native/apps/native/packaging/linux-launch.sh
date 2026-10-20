#!/bin/sh
# Launcher for an explicitly downloaded/verified native package, never a remote script.
set -eu
app_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export LD_LIBRARY_PATH="$app_dir/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$app_dir/bin/bunnyhop-native" "$@"
