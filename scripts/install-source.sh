#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

[[ $EUID -eq 0 && $# -eq 0 ]] ||
  { echo "Usage: sudo bash scripts/install-source.sh" >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
source "$source_dir/scripts/check-source-runtime.sh"
[[ -f /etc/os-release ]] || { echo "Raspberry Pi OS Trixie arm64 is required." >&2; exit 1; }
. /etc/os-release
[[ ${VERSION_CODENAME:-} == trixie && $(dpkg --print-architecture) == arm64 ]] ||
  { echo "Supported target: Raspberry Pi OS Trixie 64-bit (arm64)." >&2; exit 1; }
check_source_runtime /usr/bin/python3
exec 9>/run/lock/sendspin-karaoke-source-install.lock
flock -n 9 || { echo "Another source install is running." >&2; exit 1; }

root=/opt/sendspin-karaoke-source
state=/var/lib/sendspin-karaoke-source
config=/etc/sendspin-karaoke-source
unit=/etc/systemd/system/sendspin-karaoke-source.service
wrapper=/usr/local/bin/sendspin-karaoke-source
marker='sendspin-karaoke source installation v1'
for path in "$root" "$root/releases" "$state" "$config" "$config/environment" "$unit" "$wrapper"; do
  [[ ! -L "$path" ]] || { echo "Refusing symbolic link at managed path: $path" >&2; exit 1; }
done
if [[ -e "$root" ]]; then
  [[ -f "$root/.managed-installation" && ! -L "$root/.managed-installation" &&
      $(cat "$root/.managed-installation") == "$marker" ]] ||
    { echo "Refusing unmanaged source installation." >&2; exit 1; }
else
  [[ ! -e "$unit" && ! -e "$wrapper" ]] ||
    { echo "Refusing unmanaged source unit or CLI wrapper." >&2; exit 1; }
fi
[[ ! -e "$root/current" || -L "$root/current" ]] ||
  { echo "Refusing unmanaged current directory." >&2; exit 1; }
[[ ! -e "$config/environment" || -f "$config/environment" ]] ||
  { echo "Environment must be a regular file." >&2; exit 1; }

apt-get update
apt-get install -y --no-install-recommends python3-venv libportaudio2 libasound2-plugins libsndfile1 ca-certificates util-linux
check_source_runtime /usr/bin/python3
getent group sendspin-karaoke-source >/dev/null || groupadd --system sendspin-karaoke-source
if ! id sendspin-karaoke-source >/dev/null 2>&1; then
  useradd --system --gid sendspin-karaoke-source --home-dir "$state" --no-create-home \
    --shell /usr/sbin/nologin sendspin-karaoke-source
fi
usermod -a -G audio sendspin-karaoke-source
install -d -o root -g root -m 0755 "$root" "$root/releases"
printf '%s\n' "$marker" > "$root/.managed-installation"
chmod 0644 "$root/.managed-installation"
install -d -o sendspin-karaoke-source -g sendspin-karaoke-source -m 0700 "$state"
install -d -o root -g sendspin-karaoke-source -m 0750 "$config"
if [[ ! -e "$config/environment" ]]; then
  install -o root -g sendspin-karaoke-source -m 0640 "$source_dir/deploy/source-environment.example" "$config/environment"
fi
chown root:sendspin-karaoke-source "$config/environment"
chmod 0640 "$config/environment"

# Build a separate release; an interrupted/failed install never removes the old one.
release="$root/releases/$(date -u +%Y%m%dT%H%M%S)-$$"
install -d -o sendspin-karaoke-source -g sendspin-karaoke-source -m 0755 "$release"
install -d -o sendspin-karaoke-source -g sendspin-karaoke-source -m 0700 "$release/work" "$release/package"
install -d -m 0755 "$release/package/sendspin_karaoke_source"
install -m 0644 "$source_dir/source/sendspin_karaoke_source/"*.py "$release/package/sendspin_karaoke_source/"
install -m 0644 "$source_dir/source/pyproject.toml" "$release/package/pyproject.toml"
chown -R sendspin-karaoke-source:sendspin-karaoke-source "$release"
runuser -u sendspin-karaoke-source -- /usr/bin/python3 -I -m venv "$release/venv"
runuser -u sendspin-karaoke-source -- env TMPDIR="$release/work" \
  "$release/venv/bin/python" -I -m pip install --disable-pip-version-check --no-cache-dir "$release/package"
runuser -u sendspin-karaoke-source -- "$release/venv/bin/python" -I -c \
  'from aiosendspin.client import SendspinClient, SourceCapture; import sounddevice; import soundfile; import sendspin_karaoke_source.cli; assert soundfile.check_format("FLAC", "PCM_16") and soundfile.check_format("WAV", "PCM_16")'
runuser -u sendspin-karaoke-source -- "$release/venv/bin/sendspin-karaoke-source" --help >/dev/null
chown -R root:root "$release"
chmod -R a+rX,go-w "$release"

previous=$(readlink "$root/current" 2>/dev/null || true)
for file in "$unit" "$wrapper"; do
  if [[ -f "$file" ]]; then cp -p -- "$file" "$release/previous.$(basename "$file")"; fi
done
rollback() {
  trap - ERR
  if [[ -n "$previous" ]]; then
    ln -sfn -- "$previous" "$root/current.next"
    mv -Tf -- "$root/current.next" "$root/current"
  else
    rm -f -- "$root/current"
  fi
  for file in "$unit" "$wrapper"; do
    backup="$release/previous.$(basename "$file")"
    if [[ -f "$backup" ]]; then cp -p -- "$backup" "$file"; else rm -f -- "$file"; fi
  done
  systemctl daemon-reload || true
  echo "Source activation failed; previous release/configuration/pairing preserved." >&2
}
trap rollback ERR
install -o root -g root -m 0644 "$source_dir/deploy/sendspin-karaoke-source.service" "$unit"
install -o root -g root -m 0755 "$source_dir/scripts/source-cli.sh" "$wrapper"
ln -sfn -- "$release" "$root/current.next"
mv -Tf -- "$root/current.next" "$root/current"
systemctl daemon-reload
trap - ERR
echo "Source installed. No pairing, enable, start, restart or desktop changes were performed."
echo "List inputs: sudo -u sendspin-karaoke-source sendspin-karaoke-source devices"
echo "Pair explicitly with --server-url and --state-dir /var/lib/sendspin-karaoke-source."
echo "Edit $config/environment; then explicitly enable/start sendspin-karaoke-source.service."
echo "After an upgrade, explicitly restart the source service to use the new release."
