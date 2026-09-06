#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 027

[[ $EUID -eq 0 ]] || { echo "Run with sudo after building as your normal user." >&2; exit 1; }
[[ $# -eq 0 ]] || { echo "Usage: sudo bash scripts/install.sh" >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
source "$source_dir/scripts/check-runtime.sh"
check_system_runtime /usr/bin/node /usr/bin/npm
exec 9>/run/lock/sendspin-karaoke-install.lock
flock -n 9 || { echo "Another install, update, or uninstall is running." >&2; exit 1; }
root=/opt/sendspin-karaoke
state=/var/lib/sendspin-karaoke
config=/etc/sendspin-karaoke
unit=/etc/systemd/system/sendspin-karaoke.service

[[ -f /etc/os-release ]] || { echo "Raspberry Pi OS Trixie is required." >&2; exit 1; }
. /etc/os-release
[[ ${VERSION_CODENAME:-} == trixie && $(dpkg --print-architecture) == arm64 ]] ||
  { echo "Supported target: Raspberry Pi OS Trixie desktop, 64-bit (arm64)." >&2; exit 1; }
for file in dist/server/server/index.js dist/server/server/native-cec.py dist/web/index.html package.json package-lock.json; do
  [[ -f "$source_dir/$file" ]] || { echo "Build first as your normal user: npm ci && npm run build" >&2; exit 1; }
done
[[ ! -L "$root" && ! -L "$root/releases" && ! -L "$state" && ! -L "$config" ]] ||
  { echo "Refusing symbolic links at managed directory roots." >&2; exit 1; }
if [[ -e "$root" ]] && { [[ ! -f "$root/.managed-installation" || -L "$root/.managed-installation" ]] ||
    [[ $(cat "$root/.managed-installation") != 'sendspin-karaoke native installation v1' ]]; }; then
  echo "Refusing an existing unmanaged installation directory." >&2
  exit 1
fi
[[ ! -L "$config/environment" ]] ||
  { echo "Environment must not be a symlink." >&2; exit 1; }
if [[ -e "$root/current" && ! -L "$root/current" ]]; then
  echo "Refusing to replace an unmanaged current directory." >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends cec-utils python3 chromium curl ca-certificates util-linux
check_system_runtime /usr/bin/node /usr/bin/npm

getent group sendspin-karaoke >/dev/null || groupadd --system sendspin-karaoke
if ! id sendspin-karaoke >/dev/null 2>&1; then
  useradd --system --gid sendspin-karaoke --home-dir "$state" --no-create-home --shell /usr/sbin/nologin sendspin-karaoke
fi
for group in video dialout; do
  if getent group "$group" >/dev/null; then
    usermod -a -G "$group" sendspin-karaoke
  fi
done
install -d -o root -g root -m 0755 "$root" "$root/releases"
printf '%s\n' 'sendspin-karaoke native installation v1' > "$root/.managed-installation"
chmod 0644 "$root/.managed-installation"
install -d -o sendspin-karaoke -g sendspin-karaoke -m 0750 "$state"
install -d -o root -g sendspin-karaoke -m 0750 "$config"
if [[ ! -e "$config/environment" ]]; then
  install -o root -g sendspin-karaoke -m 0640 "$source_dir/deploy/environment.example" "$config/environment"
fi
[[ -f "$config/environment" && ! -L "$config/environment" ]] ||
  { echo "Environment must be a regular file, not a symlink." >&2; exit 1; }
chown root:sendspin-karaoke "$config/environment"
chmod 0640 "$config/environment"

# Keep all staging files on the installation filesystem, not in a temporary directory.
release="$root/releases/$(date -u +%Y%m%dT%H%M%S)-$$"
install -d -o sendspin-karaoke -g sendspin-karaoke -m 0755 "$release"
cp -R -- "$source_dir/dist" "$release/dist"
install -m 0644 "$source_dir/package.json" "$source_dir/package-lock.json" "$release/"
install -m 0755 "$source_dir/scripts/kiosk.sh" "$release/kiosk.sh"
runuser -u sendspin-karaoke -- /usr/bin/env PATH="$PATH" /usr/bin/node /usr/bin/npm \
  ci --prefix "$release" --omit=dev --ignore-scripts \
  --no-audit --no-fund --cache "$state/npm-cache"
chown -R root:root "$release"
chmod -R go-w "$release"
# The service must traverse/read assets created under the installer's restrictive umask.
chmod -R a+rX "$release"

previous=$(readlink "$root/current" 2>/dev/null || true)
if [[ -f "$unit" ]]; then
  cp -p -- "$unit" "$release/previous.service"
fi
rollback() {
  echo "New backend did not become healthy; configuration/state were preserved." >&2
  if [[ -n "$previous" ]]; then
    ln -sfn -- "$previous" "$root/current.next"
    mv -Tf -- "$root/current.next" "$root/current"
    if [[ -f "$release/previous.service" ]]; then
      install -m 0644 "$release/previous.service" "$unit"
    fi
    systemctl daemon-reload
    systemctl restart sendspin-karaoke.service || true
    echo "Previous release restored." >&2
  else
    systemctl stop sendspin-karaoke.service || true
  fi
}
install -o root -g root -m 0644 "$source_dir/deploy/sendspin-karaoke.service" "$unit"
ln -sfn -- "$release" "$root/current.next"
mv -Tf -- "$root/current.next" "$root/current"
trap rollback ERR
systemctl daemon-reload
systemctl enable sendspin-karaoke.service
systemctl restart sendspin-karaoke.service
healthy=false
for ((attempt=0; attempt<30; attempt++)); do
  if systemctl is-active --quiet sendspin-karaoke.service &&
      curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:8787/ >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done
if [[ $healthy != true ]]; then
  rollback
  trap - ERR
  exit 1
fi
trap - ERR
echo "Backend installed at http://127.0.0.1:8787/; environment and state preserved."
echo "Configure kiosk separately as the desktop user: bash scripts/configure-kiosk.sh"
echo "No reboot, Wi-Fi changes, desktop autologin changes, or CEC power/input requests were performed."
