# Upgrade an existing Pi from main

**Use this same procedure for the first move from a detached/feature checkout
to `main`, and for every later update.** `main` includes the system-Node fix,
Ambient photographs/kiosk cursor, opt-in native CEC navigation, and the measured
lyric-rendering fix. No feature-branch checkout is needed.

These are **source commit updates**, not published semantic versions or tags.
The package version alone does not identify the installed code. For a first
installation, use the [installation walkthrough](installation-guide.md).

## Before you start

This guide updates a checkout of **JamesDun2866/music-assistant-display**.
Public clones and fetches over HTTPS need no GitHub account, token or deploy
key. SSH origins are also accepted for contributors who already use SSH.

**Migrating from an older project checkout with unrelated history?** The
public repository has fresh history. Keep the old checkout and its remote
unchanged; do not merge histories, force-reset it, or merely change its origin.
Take the private backup below, then make a separate public clone using
[installation section 4](installation-guide.md#4-clone-the-public-repository).
Build and install from that new checkout using section 5. The existing managed
installation, MA environment, uploads and preferences are reused because
internal `sendspin-karaoke` paths are unchanged. Continue future updates from
the new checkout only. This does not create a second service.

On the **Pi 4/5, Trixie Desktop 64-bit, labwc**, keep your already supported
**system** `/usr/bin/node` (>=22.12.0 and <27) and matching `/usr/bin/npm`.
Do not replace them with Debian Node 20/npm or rely on nvm. If needed, use
[system runtime setup / Node 20 recovery](installation-guide.md#3-install-the-system-tools-and-check-node).
An older checkout may lack `check-runtime.sh`; the update block fetches and
switches to current `main` **before** calling it.

Have public GitHub and package-download access, and free disk space
for a build and another retained release. **Never run Git, npm ci, or the build
as root.** Only the installer and explicit backup/recovery administration need
sudo. Do not run another update/rollback concurrently.

**Recommended: take the [private backup below](#private-backup)** before upgrading.
It briefly stops the visual backend, not the independent CAST audio path.
Do not print, source, or upload the MA environment file.

## The repeatable update

**First `cd` into your actual existing source checkout** as the normal desktop
user, not `/opt/sendspin-karaoke/current`. Its location is whatever you chose
when cloning; no `$HOME/projects` location is assumed. Then paste this whole
block into **Bash on the Pi**, not Windows PowerShell:

```bash
(
  set -euo pipefail
  export PATH=/usr/sbin:/usr/bin:/sbin:/bin
  fail() { printf '%s\n' "$*" >&2; exit 1; }
  [[ $EUID -ne 0 ]] || fail "Run this block as your normal desktop user, not root."
  checkout=$(git rev-parse --show-toplevel)
  cd -- "$checkout"
  origin=$(git remote get-url origin)
  case "$origin" in
    git@github.com:JamesDun2866/music-assistant-display.git|https://github.com/JamesDun2866/music-assistant-display.git|ssh://git@github.com/JamesDun2866/music-assistant-display.git) ;;
    *) fail "Unexpected origin. Verify this is your trusted music-assistant-display clone; do not put tokens in its URL." ;;
  esac
  changes=$(git status --porcelain --untracked-files=all)
  [[ -z "$changes" ]] || fail "Local tracked/untracked changes exist. Save and reconcile them before updating; nothing was reset."
  old_head=$(git rev-parse HEAD)
  printf 'Checkout: %s\nPrevious checkout SHA: %s\n' "$checkout" "$old_head"
  git fetch origin refs/heads/main:refs/remotes/origin/main
  target=$(git rev-parse refs/remotes/origin/main)
  printf 'Fetched main SHA: %s\n' "$target"
  git merge-base --is-ancestor "$old_head" "$target" ||
    fail "Current HEAD is not contained in main. Save/name unexpected local commits and reconcile them before retrying."
  local_main=$(git for-each-ref --format='%(objectname)' refs/heads/main)
  if [[ -n "$local_main" ]]; then
    git merge-base --is-ancestor "$local_main" "$target" ||
      fail "Local main is ahead of or diverged from fetched main. Preserve and reconcile it; do not reset."
    git switch main
  else
    git switch -c main "$target"
    git config branch.main.remote origin
    git config branch.main.merge refs/heads/main
  fi
  git merge --ff-only "$target"
  revision=$(git rev-parse HEAD)
  [[ "$revision" == "$target" ]] || fail "Checkout does not exactly match fetched main."
  bash scripts/check-runtime.sh
  /usr/bin/node /usr/bin/npm ci
  /usr/bin/node /usr/bin/npm run build
  sudo bash scripts/update.sh
  installed=$(readlink -e /opt/sendspin-karaoke/current)
  diff -qr -- dist "$installed/dist"
  cmp -- scripts/kiosk.sh "$installed/kiosk.sh"
  record_dir="${XDG_STATE_HOME:-$HOME/.local/state}/sendspin-karaoke"
  install -d -m 0700 -- "$record_dir"
  (umask 077; printf '%s checkout=%s release=%s\n' "$(date -u +%FT%TZ)" "$revision" "$installed" >> "$record_dir/upgrades.log")
  printf 'Installed from checkout SHA: %s\nInstalled release: %s\nRecord: %s/upgrades.log\n' "$revision" "$installed" "$record_dir"
)
```

The subshell stops on failure without changing your shell's options or PATH.
It refuses dirty tracked/untracked files, local-only detached/feature commits,
and ahead/diverged local `main`. **Do not bypass a refusal with reset/force.**
Save local work (name a detached commit on a branch before leaving it), reconcile
it deliberately, then retry. Ignored `.env` files remain untouched and do not
block the update; never commit them to make the checkout clean.

The explicit fetch works even in an old `--single-branch` feature clone. It
does not replace other fetch configuration, delete branches, or require another
`git pull`. A newly created `main` gets tracking configuration explicitly:
`--track origin/main` alone may fail when the clone's fetch mapping only names
the old feature. Continue using the full block on subsequent updates.

`scripts/update.sh` takes **no arguments** and simply runs `install.sh`; it
does **not fetch source or build**. The block does both first, with system Node.
The installer preflights that runtime before lock/APT changes, installs its
non-Node OS packages and script-free production npm dependencies, copies the
built `dist` (including the native CEC helper) and launcher, then atomically
selects a timestamp-plus-PID release under `/opt/sendspin-karaoke/releases`.
It preserves `/etc/sendspin-karaoke/environment` and `/var/lib/sendspin-karaoke`,
including uploads, view, slideshow and lyric offset. It does not reboot or
request CEC wake/input/standby; an already opted-in listener restarts with its
existing configuration and registers its playback identity.

## Check the service and refresh the screen

```sh
systemctl is-active sendspin-karaoke.service
curl --noproxy '*' --fail --show-error --max-time 5 http://127.0.0.1:8787/healthz
curl --noproxy '*' --show-error --max-time 5 -w '\nHTTP %{http_code}\n' http://127.0.0.1:8787/readyz
sudo journalctl -u sendspin-karaoke.service -n 50 --no-pager
```

`/healthz` proves only local HTTP liveness. `/readyz` may return **503 while
MA is offline/unready**, even with a working Ambient display. Neither checks
actual CAST audio, lyric availability, HDMI, LG/Onkyo forwarding or Pi smoothness.
Review logs privately before sharing.

**Reload the browser** for new UI assets. **Once, when replacing an older kiosk
launcher**, log out of the desktop and back in to pick up `?kiosk=1`. Closing
Chromium alone leaves the old launcher's respawn loop running. The existing
managed `/bin/bash /opt/sendspin-karaoke/current/kiosk.sh &` autostart entry needs
**no `configure-kiosk.sh` rerun**. No reboot is required. Normal admin/tunnel
URLs omit `?kiosk=1` and keep their pointer.

For a pointer that remains visible after the TV has already reloaded, collect
[kiosk pointer diagnostics](kiosk-pointer.md) from SSH or the admin browser.
The new diagnostic reporter requires the TV page to load the updated UI; a
backend restart alone is insufficient. It does not change the launcher or
labwc configuration, and repeated logout/reboot is not a cursor fix.
Separately, the [opt-in native startup workaround](kiosk-pointer.md#opt-in-to-native-startup-hiding)
adds a supported kiosk-triggered labwc rule. After upgrading, explicitly run
`/usr/bin/python3 scripts/configure-kiosk-cursor.py --enable` as the desktop
user, then reboot once when ready so the rule loads before a fresh launcher
and browser map. This optional step temporarily hides the whole seat cursor
until pointer activity, including after leaving the kiosk; it is not enabled
by an ordinary update. See the linked guide for removal and recovery.
If an earlier helper refused **`labwc -m`** as custom/merged config, update
from main and rerun the same `--enable` command while the desktop is running.
Stock Pi merged mode is supported without duplicating system defaults.
Do not remove `-m`, bypass the guard, or reboot until enable succeeds.

This same procedure delivers **34 bundled, individually verified CC0 photos at 3840x2160**
(58.07 MiB including thumbnails); there is no separate photo download step.
Your uploads/settings persist, and the original four photo IDs now resolve to
native 4K copies of the same works. Existing selections are not silently
expanded: open Scene library to add more photos. Old uploaded 1080p display
copies cannot regain lost pixels; re-upload their originals for a new 4K-bounded
copy. Thumbnail migration does not regenerate full-size images.
Back up state before rollback: a release with the old selection/dimension
limits cannot necessarily read newer 4K uploads or an expanded selection.
The Pi desktop/HDMI must actually output 3840x2160 to show full 4K detail;
1080p remains an option for smoother lyrics. No display-mode change is automated. See
[display controls](display.md) and [photo provenance](background-credits.md).
The [scrolling fix](scrolling-performance.md) removes measured redundant
software work; it is **not a guaranteed cure for physical Pi 4 stutter**.

CEC remains **opt-in**, with existing configuration preserved. Before enabling
it, follow [read-only device discovery and the native `--probe`](cec.md#1-inspect-the-connected-kernel-device-read-only).
Only after identifying the actual connected node, use `sudoedit
/etc/sendspin-karaoke/environment` to adjust these entries in the existing file:

```ini
CEC_ENABLED=true
CEC_REMOTE_ENABLED=true
CEC_DEVICE=/dev/cecN
CEC_ALLOW_STANDBY=false
DEMO_MODE=false
```

`/dev/cecN` is a **placeholder**, not a literal device: substitute the discovered
node, never blindly select `cec0`. Retain valid existing MA URL/token/player/queue
configuration before using live mode. Follow the [opt-in/restart steps](cec.md#3-opt-in-and-open-exactly-one-kiosk-page);
do not test with CEC power writes. Magic pointer/voice, power and volume are not
app navigation. Actual LG/Onkyo forwarding remains unqualified on your hardware.

This main-only upgrade also includes conservative manual-input acknowledgement:
the native listener replies to an exact TV-origin broadcast Set Stream Path
for its own verified path, never merely to startup/reconnect or an ancestor route.
If native CEC is already enabled, **keep your verified `CEC_DEVICE` unchanged**
and retain `CEC_ENABLED=true`, `CEC_REMOTE_ENABLED=true`, `DEMO_MODE=false` and
the existing protected MA configuration. Do not replace the environment file;
no startup option is needed or added. After the service update and browser reload,
inspect Display's last routing event/acknowledgement and last accepted key while
deliberately selecting the Pi on the TV/receiver. No exact forwarded TV request
means no acknowledgement; a sent reply is not proof of remote forwarding.
There is no extra wake, but vendor power/routing effects cannot be ruled out.

## Identify a checkout versus an installed release

The block records the successful checkout SHA and selected release path in your
private `upgrades.log`, after comparing built/installed files. There is **no
embedded source-revision manifest**: `git rev-parse HEAD` identifies only the
checkout, not a currently running process; release timestamps are not commit IDs.
To compare the current checkout's already-built UI with installed assets:

```sh
# From your actual source checkout; do not rebuild just to identify an old release.
git rev-parse HEAD
readlink -e /opt/sendspin-karaoke/current
sha256sum dist/web/assets/index-*.js
sha256sum /opt/sendspin-karaoke/current/dist/web/assets/index-*.js
```

Matching names/hashes tie those installed UI files to that build, not to an
unbuilt checkout or the browser's cached page. A later build, update or rollback
can invalidate that comparison. Save the release path **before** updating too.

## Private backup

For an **existing managed installation**, run this separate block before the
update. It creates a root-private **0700** directory, records the current release,
and archives configuration, the complete state and the unit with the service
stopped. It attempts to start the service again **even if the archive fails**.
The installer lock excludes concurrent install/update/uninstall during backup.

```bash
sudo /bin/bash <<'BACKUP'
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
exec 9>/run/lock/sendspin-karaoke-install.lock
flock -n 9
install -d -o root -g root -m 0700 /var/backups/sendspin-karaoke
backup=$(mktemp -d "/var/backups/sendspin-karaoke/backup-$(date -u +%Y%m%dT%H%M%S)-XXXXXX")
readlink -e /opt/sendspin-karaoke/current > "$backup/release-path.txt"
restart_after_backup() {
  result=$?
  trap - EXIT
  if ! systemctl start sendspin-karaoke.service; then
    echo "Service restart failed; inspect systemctl/journalctl before continuing." >&2
    exit 1
  fi
  exit "$result"
}
trap restart_after_backup EXIT
systemctl stop sendspin-karaoke.service
tar -C / -czf "$backup/config-state-unit.tar.gz" \
  etc/sendspin-karaoke var/lib/sendspin-karaoke \
  etc/systemd/system/sendspin-karaoke.service
systemctl start sendspin-karaoke.service
trap - EXIT
printf 'Private backup: %s\n' "$backup"
BACKUP
```

If it fails, stop and resolve the error; a partial archive is not a backup.
Also retain the desktop user's labwc autostart and any manual TV/AVR settings.
This is not an OS/SD-card image or a backup of `/opt` releases: keep the recorded
release directory. Archives include the MA token and private media/cache, so
transfer only to private/encrypted storage, never GitHub.

## Recovery without resetting Git

On failed local-page startup, the installer restores the previous release symlink
and its saved unit and attempts a restart. This is **liveness rollback only**,
not restoration of state, secrets or MA readiness.

For a deliberate manual rollback, first inspect `readlink -e
/opt/sendspin-karaoke/current` and retained directories in
`/opt/sendspin-karaoke/releases`. Use the **exact pre-upgrade release path you
recorded**, not whichever directory sorts last. The release that replaced it
contains `previous.service`, a copy of the unit from immediately before that
update; alternatively use the corresponding unit from your private backup.

**Review schema compatibility before starting an older release.** Older settings
schemas may require the matching pre-upgrade state backup. Preserve today's
state first and review the backup privately; do not blindly extract an entire
archive over `/`, wipe state, delete new settings fields, or overwrite a newer
MA token. If compatibility is uncertain, stop and plan a matched code/state
recovery rather than guessing.

This **operator template** deliberately refuses to run unchanged. Replace the
release and unit paths with the recorded, retained code and its matching unit
(or a privately extracted matching unit from backup). Set the confirmation to
`yes` **only after confirming that code, current state and unit are compatible**.
It does not restore state or credentials. Stop other maintenance first.

```bash
sudo /bin/bash <<'ROLLBACK'
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
release=/opt/sendspin-karaoke/releases/REPLACE_WITH_RECORDED_RELEASE_ID
unit=/absolute/path/to/MATCHING.service
confirmed_matching_code_state_unit=no
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$confirmed_matching_code_state_unit" == yes ]] ||
  fail "Confirm the recorded code, current state and chosen unit match before rollback."
exec 9>/run/lock/sendspin-karaoke-install.lock
flock -n 9 || fail "Another installation or recovery operation is running."
root=/opt/sendspin-karaoke
[[ "$release" == "$root/releases/${release##*/}" && -d "$release" && ! -L "$release" ]] ||
  fail "Choose an existing retained release directly under releases."
resolved=$(readlink -e -- "$release")
[[ "$resolved" == "$release" && -L "$root/current" ]] || fail "Unexpected installation paths."
[[ -f "$release/dist/server/server/index.js" && -f "$release/dist/web/index.html" && -f "$release/kiosk.sh" ]] ||
  fail "The selected release is incomplete."
[[ "$unit" == /* && -f "$unit" && ! -L "$unit" ]] || fail "Choose the matching regular unit file."
[[ "$(stat -c '%U:%G' -- "$release" "$unit")" == $'root:root\nroot:root' ]] ||
  fail "The retained release and unit must be root-owned."
next="$root/current.rollback-$$"
[[ ! -e "$next" && ! -L "$next" ]] || fail "Temporary rollback path already exists."
trap 'rm -f -- "$next"' EXIT
trap 'echo "Rollback failed; inspect the service and selected code/unit before restarting." >&2' ERR
systemctl stop sendspin-karaoke.service
install -o root -g root -m 0644 -- "$unit" /etc/systemd/system/sendspin-karaoke.service
ln -s -- "$release" "$next"
mv -Tf -- "$next" "$root/current"
systemctl daemon-reload
systemctl start sendspin-karaoke.service
systemctl is-active --quiet sendspin-karaoke.service
curl --noproxy '*' --fail --silent --show-error --max-time 5 \
  --retry 10 --retry-connrefused --retry-delay 1 --retry-max-time 20 http://127.0.0.1:8787/healthz
printf '\nSelected retained release: %s\n' "$release"
ROLLBACK
```

If anything fails after stopping, leave further recovery deliberate; the
template does not guess another release or restart an uncertain code/unit pair.
Run the readiness checks above, refresh the browser, and log out/in if reverting
the launcher too. Do not run Git as root or rerun an old source installer that
requests conflicting Debian `nodejs npm`. Keep releases/backups until recovery
is no longer needed; never prune the active release.
