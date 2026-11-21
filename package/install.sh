#!/bin/sh
# Deprecated, kept for one release: the installer is now install.mjs (Windows, macOS, Linux).
exec node "$(dirname "$0")/install.mjs" "$@"
