#!/bin/bash
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run Chromium as the logged-in desktop user, not root." >&2; exit 1; }
[[ -n ${WAYLAND_DISPLAY:-} && -n ${XDG_RUNTIME_DIR:-} ]] ||
  { echo "Launch from the labwc desktop session (Wayland environment required)." >&2; exit 1; }
[[ -x /usr/bin/chromium ]] || { echo "Install the chromium package." >&2; exit 1; }
exec 9>"$XDG_RUNTIME_DIR/sendspin-karaoke-kiosk.lock"
flock -n 9 || exit 0
profile="${XDG_CONFIG_HOME:-$HOME/.config}/sendspin-karaoke/chromium"
mkdir -p -- "$profile"
chmod 0700 "$profile"
browser_pid=
cleanup() {
  if [[ -n "$browser_pid" ]]; then
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP
while true; do
  until curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:8787/ >/dev/null; do
    sleep 2
  done
  /usr/bin/chromium --ozone-platform=wayland --class=sendspin-karaoke-kiosk --kiosk --noerrdialogs --no-first-run \
    --disable-session-crashed-bubble --password-store=basic --user-data-dir="$profile" \
    'http://127.0.0.1:8787/?kiosk=1' &
  browser_pid=$!
  wait "$browser_pid" || true
  browser_pid=
  sleep 3
done
