#!/bin/bash
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run as the desktop user WITHOUT sudo." >&2; exit 1; }
mode=${1:-install}
[[ $mode == install || $mode == --remove ]] ||
  { echo "Usage: bash scripts/configure-kiosk.sh [--remove]" >&2; exit 1; }
file="${XDG_CONFIG_HOME:-$HOME/.config}/labwc/autostart"
mkdir -p -- "$(dirname -- "$file")"
[[ ! -L "$file" ]] || { echo "Refusing to modify a symlinked autostart." >&2; exit 1; }
if [[ ! -e "$file" ]]; then
  # A per-user file overrides the system autostart; preserve existing desktop startup.
  if [[ -f /etc/xdg/labwc/autostart ]]; then
    cp -- /etc/xdg/labwc/autostart "$file"
  else
    : > "$file"
  fi
fi
begin='# BEGIN sendspin-karaoke managed kiosk'
end='# END sendspin-karaoke managed kiosk'
# Reject malformed markers rather than risk deleting unrelated desktop setup.
/usr/bin/node --input-type=module - "$file" "$mode" "$begin" "$end" <<'NODE'
import fs from 'node:fs';
const [file, mode, begin, end] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const lines = text.split('\n');
let inside = false;
let blocks = 0;
const kept = [];
for (const line of lines) {
  if (line === begin) {
    if (inside || blocks++) throw new Error('Duplicate or nested kiosk markers; repair manually.');
    inside = true;
  } else if (line === end) {
    if (!inside) throw new Error('Unmatched kiosk end marker; repair manually.');
    inside = false;
  } else if (!inside) kept.push(line);
}
if (inside) throw new Error('Unmatched kiosk start marker; repair manually.');
let next = kept.join('\n').replace(/\n*$/, '\n');
if (mode === 'install') {
  next += `${begin}\n/bin/bash /opt/sendspin-karaoke/current/kiosk.sh &\n${end}\n`;
}
if (next !== text) {
  const backup = `${file}.before-sendspin-karaoke`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(file, next);
}
NODE
echo "Kiosk autostart updated for this desktop user. Takes effect at next desktop login."
echo "Desktop autologin and screen blanking are unchanged; configure manually in Control Centre."
