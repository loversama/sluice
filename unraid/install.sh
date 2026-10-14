#!/bin/bash
# One-command Sluice install for Unraid. Paste into the Unraid terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/loversama/sluice/master/unraid/install.sh | bash
#
# Unraid no longer reads Template Repositories, so a template has to be placed on the flash
# drive by hand. This does that, then creates the container exactly as Unraid's own Add
# Container would - same name, labels and template - so it shows in the Docker tab with its
# icon and WebUI and can be edited from there like any other. Safe to run again: it replaces
# the container and keeps everything in the appdata folder, including the Twitch login.
set -euo pipefail

NAME="${SLUICE_NAME:-sluice}"
IMAGE="${SLUICE_IMAGE:-ghcr.io/loversama/sluice:latest}"
APPDATA="${SLUICE_APPDATA:-/mnt/user/appdata/sluice}"
TEMPLATE_DIR="${SLUICE_TEMPLATE_DIR:-/boot/config/plugins/dockerMan/templates-user}"
AUTOSTART="${SLUICE_AUTOSTART_FILE:-/var/lib/docker/unraid-autostart}"
TEMPLATE_URL="${SLUICE_TEMPLATE_URL:-https://raw.githubusercontent.com/loversama/sluice/master/unraid/sluice.xml}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- Settings worked out from the server, so nothing has to be typed in. ---
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
ALLOWED_HOSTS="${HOSTNAME_SHORT},${HOSTNAME_SHORT}.local"
TZ_NAME="$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p')"
TZ_NAME="${TZ_NAME:-Europe/London}"
SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
SERVER_IP="${SERVER_IP:-$HOSTNAME_SHORT}"

say "Downloading Sluice..."
docker pull "$IMAGE" || docker image inspect "$IMAGE" >/dev/null

if docker container inspect "$NAME" >/dev/null 2>&1; then
    say "Replacing the existing '$NAME' container (data in $APPDATA is kept)..."
    docker rm -f "$NAME" >/dev/null
fi

# The first free port from 4400 up, so a clash with another container does not stop it.
port_in_use() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
    else
        netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
    fi
}
PORT="${SLUICE_PORT:-4400}"
while port_in_use "$PORT"; do PORT=$((PORT + 1)); done

mkdir -p "$APPDATA"

# Unraid links a container to the template named my-<container name>.xml.
if [ -d "$(dirname "$TEMPLATE_DIR")" ]; then
    mkdir -p "$TEMPLATE_DIR"
    curl -fsSL "$TEMPLATE_URL" |
        sed -e "s#<Name>sluice</Name>#<Name>${NAME}</Name>#" \
            -e "s#\(Name=\"Dashboard port\"[^>]*>\)[^<]*<#\1${PORT}<#" \
            -e "s#\(Name=\"Data\"[^>]*>\)[^<]*<#\1${APPDATA}<#" \
            -e "s#\(Name=\"TZ\"[^>]*>\)[^<]*<#\1${TZ_NAME}<#" \
            -e "s#\(Name=\"Allowed hostnames\"[^>]*>\)[^<]*<#\1${ALLOWED_HOSTS}<#" \
            >"$TEMPLATE_DIR/my-${NAME}.xml"
fi

say "Starting Sluice on port $PORT..."
docker run -d \
    --name="$NAME" \
    --net=bridge \
    -e TZ="$TZ_NAME" \
    -e HOST_OS="Unraid" \
    -e HOST_HOSTNAME="$HOSTNAME_SHORT" \
    -e HOST_CONTAINERNAME="$NAME" \
    -e PUID=99 \
    -e PGID=100 \
    -e SLUICE_ALLOWED_HOSTS="$ALLOWED_HOSTS" \
    -l net.unraid.docker.managed=dockerman \
    -l "net.unraid.docker.webui=http://[IP]:[PORT:4400]/" \
    -l net.unraid.docker.icon=https://raw.githubusercontent.com/loversama/sluice/master/web/public/icon-512.png \
    -p "${PORT}:4400/tcp" \
    -v "${APPDATA}:/data:rw" \
    "$IMAGE" >/dev/null

# Start with the array, like containers added through the Docker tab.
if [ -d "$(dirname "$AUTOSTART")" ] && ! grep -qx "$NAME" "$AUTOSTART" 2>/dev/null; then
    echo "$NAME" >>"$AUTOSTART"
fi

# Wait for either the sign-in code or a stored login to be picked up.
LOGS=""
for _ in $(seq 1 30); do
    LOGS="$(docker logs "$NAME" 2>&1 || true)"
    if grep -q "Enter the code\|Logged in as" <<<"$LOGS"; then break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then break; fi
    sleep 1
done

if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    say "Sluice stopped straight away. Its log:"
    docker logs --tail 30 "$NAME" 2>&1
    exit 1
fi

say "Sluice is running."
echo "  Dashboard:  http://${SERVER_IP}:${PORT}/"
echo "  Data:       ${APPDATA}"
CODE="$(grep -o 'Enter the code: *[A-Z0-9]*' <<<"$LOGS" | tail -1 | awk '{print $NF}')"
if [ -n "$CODE" ]; then
    echo
    echo "  Last step: sign in to Twitch."
    echo "  Open https://www.twitch.tv/activate and enter:  ${CODE}"
    echo "  (The dashboard shows the code too, and gets a new one if it expires.)"
elif grep -q "Logged in as" <<<"$LOGS"; then
    echo "  $(grep -o 'Logged in as [^ ]*' <<<"$LOGS" | tail -1). Nothing else to do."
fi
