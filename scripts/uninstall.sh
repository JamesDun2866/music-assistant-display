#!/bin/bash
set -euo pipefail
umask 027
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
[[ $# -eq 0 ]] || { echo "No purge option: state and secrets are always preserved." >&2; exit 1; }
exec 9>/run/lock/sendspin-karaoke-install.lock
flock -n 9 || { echo "Another install, update, or uninstall is running." >&2; exit 1; }
root=/opt/sendspin-karaoke
[[ ! -L "$root" ]] || { echo "Refusing a symlinked installation root." >&2; exit 1; }
if [[ -e "$root" ]] && { [[ ! -f "$root/.managed-installation" || -L "$root/.managed-installation" ]] ||
    [[ $(cat "$root/.managed-installation") != 'sendspin-karaoke native installation v1' ]]; }; then
  echo "Refusing to remove an unmanaged installation directory." >&2
  exit 1
fi
if systemctl cat sendspin-karaoke.service >/dev/null 2>&1; then
  systemctl disable --now sendspin-karaoke.service
fi
rm -f -- /etc/systemd/system/sendspin-karaoke.service
systemctl daemon-reload
rm -rf --one-file-system -- "$root"
echo "Backend removed. Preserved /etc/sendspin-karaoke, /var/lib/sendspin-karaoke and service account."
echo "As each desktop user, remove kiosk autostart: bash scripts/configure-kiosk.sh --remove"
echo "Then log out of the desktop to stop its kiosk. Chromium profile and OS packages are preserved."
