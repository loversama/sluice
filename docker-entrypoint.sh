#!/bin/sh
# Hand /data to the user Sluice runs as, then drop root.
#
# Unraid (and Docker itself) creates a missing appdata folder as root, which a fixed
# non-root user cannot write - the first launch would fail to save config.json. Starting
# as root just long enough to fix ownership means no one has to chown anything by hand.
# PUID/PGID follow the convention Unraid templates use; the defaults match the `node`
# user the image always ran as, so existing ./data folders keep working unchanged.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
    mkdir -p /data
    if [ "$(stat -c %u:%g /data)" != "$PUID:$PGID" ]; then
        # Some mounts (a Windows drive under WSL, many network shares) refuse chown but
        # are writable anyway. Carry on and let a genuinely unwritable folder fail loudly
        # at the first save, where the error names the file.
        chown -R "$PUID:$PGID" /data 2>/dev/null ||
            echo "Could not change the owner of /data to $PUID:$PGID; continuing." >&2
    fi
    exec su-exec "$PUID:$PGID" "$@"
fi

# Started with --user already: nothing to fix, and no permission to fix it anyway.
exec "$@"
