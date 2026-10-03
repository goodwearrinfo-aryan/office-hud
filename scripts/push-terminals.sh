#!/bin/bash
# Publish this machine's terminal + session state into the office-hud hive.
#
# The HUD runs on the mini and reads one hive directory. This lets any other
# machine contribute its own view: collect locally, then copy the single JSON
# document into <remote hive>/remote/<short-host>/ where the HUD merges it.
#
# Failure is non-fatal by design. A laptop that is asleep, offline, or mid-sleep
# must not turn into a red error on the dashboard; the HUD treats a missing or
# stale remote file as "that host did not report yet" and shows the age.
set -u

HIVE="${OFFICE_HUD_HIVE:-$HOME/openalice-fleet/hive}"
REMOTE_HOST="${OFFICE_HUD_PUSH_HOST:-macmini}"
REMOTE_BASE="${OFFICE_HUD_PUSH_DIR:-/Users/a/trading/openalice-fleet/hive/remote}"
COLLECTOR="$(dirname "$0")/collect-terminals.py"

# Collect locally first. If this fails there is nothing worth sending.
if ! python3 "$COLLECTOR" "$HIVE"; then
  echo "collection failed; nothing pushed" >&2
  exit 0
fi

SHORT_HOST=$(python3 -c 'import socket; print(socket.gethostname().split(".")[0])')
SRC="$HIVE/terminals.json"
DEST="$REMOTE_BASE/$SHORT_HOST"

# Both directories are needed: the staging one to receive the upload, and the
# final one to move it into. Creating only the staging dir makes the mv fail
# with no destination, leaving the file stranded in .tmp.
ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" "mkdir -p '$DEST' '$DEST.tmp'" 2>/dev/null
if scp -q -o ConnectTimeout=10 "$SRC" "$REMOTE_HOST:$DEST.tmp/terminals.json" 2>/dev/null; then
  # Move first, then clean up the staging dir separately: folding rmdir into
  # the same && chain reports failure even when the move worked, because rmdir
  # legitimately fails if anything else landed in the staging dir.
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" \
       "mv '$DEST.tmp/terminals.json' '$DEST/terminals.json'" 2>/dev/null; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" "rmdir '$DEST.tmp'" >/dev/null 2>&1
    echo "published $SHORT_HOST -> $DEST/terminals.json"
  else
    echo "published $SHORT_HOST (rename failed; HUD will ignore the partial file)"
  fi
else
  echo "could not reach $REMOTE_HOST; kept local state only"
fi
