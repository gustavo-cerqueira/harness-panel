#!/usr/bin/env bash
# Starts the Harness Control Panel. Idempotent: if the port is already
# serving the panel, it says so and exits 0 rather than failing a VSCode task.
#
# The panel is read-only — it never writes to any config file.
set -euo pipefail

PORT="${HARNESS_PORT:-${EZ_HARNESS_PORT:-4546}}"
URL="http://127.0.0.1:${PORT}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$HERE")"
# The repository to inventory is the one you are standing in, resolved to its
# root so running this from a subdirectory still reads the whole checkout.
# HARNESS_REPO wins when set, which is how a launcher pins a fixed workspace.
REPO_ROOT="${HARNESS_REPO:-${EZ_HARNESS_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"

if curl -fsS -o /dev/null --max-time 2 "${URL}/api/state" 2>/dev/null; then
	echo "Harness Control Panel already running -> ${URL}"
	exit 0
fi

# Port held by something that is not the panel: report it instead of killing a
# process we do not own.
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
	echo "Port ${PORT} is in use by another process:" >&2
	lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >&2
	echo "Free it, or set HARNESS_PORT to another port." >&2
	exit 1
fi

echo "Starting Harness Control Panel -> ${URL}"
echo "  repo: ${REPO_ROOT}"
HARNESS_REPO="${REPO_ROOT}" exec node "${APP_DIR}/server.mjs"
