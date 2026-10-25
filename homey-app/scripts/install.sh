#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd -- "$app_dir/.." && pwd)"
app_version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$app_dir/package.json" | head -1)"
[[ -n "$app_version" ]] || { printf '%s\n' 'The Meross Connect version is missing.' >&2; exit 1; }
image_name="metalcated/homey-meross-installer:${app_version}"
container_name="homey-meross-installer-$(date +%Y%m%d-%H%M%S)-$$"
auth_volume="${HOMEY_AUTH_VOLUME:-homey-meross-cli-auth}"
[[ "$auth_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { printf '%s\n' 'HOMEY_AUTH_VOLUME must be a Docker volume name.' >&2; exit 1; }
install_url=''
tunnel_pid=''

cleanup() {
    if [[ -n "$tunnel_pid" ]]; then
        kill "$tunnel_pid" 2>/dev/null || true
        wait "$tunnel_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT

[[ "$#" -le 1 ]] || { printf '%s\n' 'Usage: install.sh [--via-foreman]' >&2; exit 1; }
case "${1:-}" in
    '') ;;
    --via-foreman)
        ssh_jump="${HOMEY_SSH_JUMP:-foreman.gnet.com}"
        ssh_target="${HOMEY_SSH_TARGET:-iot-mgmt}"
        tunnel_port="${HOMEY_TUNNEL_PORT:-14859}"
        [[ "$ssh_jump" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ && "$ssh_target" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ && "$tunnel_port" =~ ^[0-9]{1,5}$ ]] || {
            printf '%s\n' 'Invalid tunnel host or port.' >&2; exit 1;
        }
        ((10#$tunnel_port >= 1 && 10#$tunnel_port <= 65535)) || { printf '%s\n' 'The tunnel port must be between 1 and 65535.' >&2; exit 1; }
        command -v ssh >/dev/null || { printf '%s\n' 'SSH is required for the tunnel option.' >&2; exit 1; }
        ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
            -L "127.0.0.1:${tunnel_port}:${ssh_target}:4859" "$ssh_jump" &
        tunnel_pid=$!
        sleep 1
        kill -0 "$tunnel_pid" 2>/dev/null || { printf '%s\n' 'The Homey tunnel could not start.' >&2; exit 1; }
        install_url="http://host.docker.internal:${tunnel_port}"
        ;;
    *) printf '%s\n' 'Usage: install.sh [--via-foreman]' >&2; exit 1 ;;
esac

command -v docker >/dev/null || { printf '%s\n' 'Docker is required. Start Docker and run this script again.' >&2; exit 1; }
docker info >/dev/null
docker build --file "$app_dir/Dockerfile" --tag "$image_name" "$repo_dir"

printf '%s\n' \
    'Select your self-hosted Homey when prompted, or set HOMEY_ID to select it by ID.' \
    'If Homey asks you to sign in, open its link in your browser.' \
    'Paste any sign-in code only into this terminal, never into chat.' \
    'Installation adds or updates Meross Connect using its own app identity.' \
    'Add and test your Meross devices separately after installation.' \
    "Your Homey login stays in the ${auth_volume} Docker volume."

run_options=(--interactive)
if [[ -t 0 && -t 1 ]]; then run_options+=(--tty); fi
docker run "${run_options[@]}" --name "$container_name" \
    --env HOMEY_HOME=/auth \
    --mount "type=volume,source=${auth_volume},target=/auth" \
    --env "HOMEY_ID=${HOMEY_ID:-}" \
    --env "HOMEY_INSTALL_URL=${install_url}" \
    "$image_name"
