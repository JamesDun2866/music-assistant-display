# Native Raspberry Pi kiosk

**First installation? Start with the [complete installation walkthrough](installation-guide.md).**
It covers hardware, Wi-Fi, anonymous public-repository access, exact player/queue
discovery, kiosk setup and optional model-checked Onkyo routing. This page is
the operational reference for the native scripts and service layout.

## Supported target and design

Use a **fresh Raspberry Pi OS Trixie (Debian 13), 64-bit desktop image**, with its
default **labwc/Wayland** session. The project baseline is a **Pi 4 or Pi 5 with
2 GB RAM**, a reliable power supply, microSD storage, and HDMI display. More RAM
helps with large artwork; no performance or HDMI compatibility claim replaces a
test on your own TV. OS Lite, legacy LXDE/X11, and older Wayfire configurations are
not covered by these scripts.

This follows Raspberry Pi's
[official kiosk tutorial](https://www.raspberrypi.com/tutorials/how-to-use-a-raspberry-pi-in-kiosk-mode/):
start `chromium` from the desktop user's `~/.config/labwc/autostart`, with `&`.
The [official Trixie announcement](https://www.raspberrypi.com/news/trixie-the-new-version-of-raspberry-pi-os/)
describes the current desktop and Control Centre. These sources were checked on
2026-09-05; old guides using `chromium-browser`, LXDE autostart, or X11 `xset`
are not this deployment strategy.

The backend runs natively as an unprivileged **system service**, independent of
desktop login or Wi-Fi. Chromium runs separately as your **desktop user**, retaining
the Wayland environment inherited directly from labwc. No graphical session
variables are guessed or imported into a system service. There is no Docker image,
privileged container, root browser, `--no-sandbox`, or browser-held MA credential.

## Prepare the Pi

1. Use Raspberry Pi Imager to provision the desktop image, your user account,
   hostname, Wi-Fi country/network, and preferably SSH keys. Boot and verify the
   desktop works.
2. In Control Centre (or `sudo raspi-config`), **manually enable desktop autologin**
   for the intended desktop user, if appropriate for the physical security of the
   device. Console autologin is not sufficient.
3. Disable display blanking in the OS's display/preferences settings if wanted.
   Neither screen blanking nor TV power policy is changed by the installer.
4. Provision **system Node >=22.12.0 and <27 with matching npm** using
   [the installation guide's runtime steps](installation-guide.md#3-install-the-system-tools-and-check-node),
   then clone a trusted checkout as your normal user. Trixie's Debian Node
   package can be 20.19.2; do not assume `apt install nodejs npm` meets the range.
   NodeSource's `nodejs` includes npm and conflicts with Debian's separate npm.
   Inside the checkout:

   ```sh
   export PATH=/usr/sbin:/usr/bin:/sbin:/bin
   bash scripts/check-runtime.sh &&
   /usr/bin/node /usr/bin/npm ci &&
   /usr/bin/node /usr/bin/npm run build
   ```

   Run the npm commands **inside the checkout**, not with sudo. The system
   `/usr/bin/node` must be **22.12 or newer, below 27**, and must be able to run
   `/usr/bin/npm --version`. An `nvm`-only runtime is not available to the service.
   The checker is read-only and can run without sudo. If the repository's
   engine requirement changes, follow `package.json`.

5. Install the built release:

   ```sh
   sudo bash scripts/install.sh
   bash scripts/configure-kiosk.sh
   ```

The installer preflights `/usr/bin/node` and `/usr/bin/npm` **before creating
its lock or performing package/account/filesystem/service mutations**. It
checks for Trixie arm64 and requests only `cec-utils`, `python3`, `chromium`, `curl`,
`ca-certificates`, and `util-linux` through apt, then rechecks the runtime.
It never installs Node/npm packages or configures a third-party repository.
Unsupported/missing system runtime means an actionable failure, not a fallback
to Debian Node or a personal nvm installation.

Production dependencies use `/usr/bin/node /usr/bin/npm ci` as the service user,
with lifecycle scripts disabled and an explicit system-only PATH. This avoids
npm's env-node shebang selecting another runtime, including if sudo/runuser
change PATH. The systemd unit also sets a system PATH and starts the absolute
`/usr/bin/node`; it does not inherit nvm from the desktop. Internet access is
needed for package downloads unless you provide a local package mirror/cache.

Image uploads use Sharp's optional, prebuilt native decoder packages. Do not
install with `--omit=optional` or copy Windows/x64 `node_modules` onto the Pi.
The lockfile includes `@img/sharp-linux-arm64` and its glibc libvips package;
[Sharp supports Linux ARM64 with glibc >=2.28](https://sharp.pixelplumbing.com/install/),
compatible with Trixie's platform baseline. Normal production installation
retains optional dependencies while using `--omit=dev --ignore-scripts`;
no native compilation or lifecycle scripts are required for the supported
prebuilt target. This is package/platform verification, not a Pi hardware run.

The initial configuration runs demo mode with **CEC disabled**. Installation and
startup do not send CEC commands, change Wi-Fi/autologin, or reboot.
An already opted-in native listener can acknowledge a later TV broadcast selecting
its exact verified physical path, with no extra wake. This is a solicited manual
selection response, not a boot/reconnect takeover; see [CEC limits and diagnostics](cec.md).

Log out and back into the desktop when ready to activate the kiosk. The autostart
script preserves other user entries, copies the system labwc autostart when creating
the first user override, and maintains exactly one marked block. It saves the original
as `autostart.before-sendspin-karaoke`. Malformed or duplicate markers fail safely.

## Files, identity, and configuration

The public repository/checkout is `music-assistant-display`. Installed paths,
service/account names, managed markers and the browser profile deliberately
remain `sendspin-karaoke` for compatibility. Do not rename or create duplicate
units or state directories when moving to the public source.

| Location | Purpose |
| --- | --- |
| `/opt/sendspin-karaoke/releases/<id>` | Root-owned versioned application and production dependencies |
| `/opt/sendspin-karaoke/current` | Atomic symlink selecting the active release |
| `current/dist/server/server/index.js` | Compiled backend entry point |
| `current/dist/server/server/native-cec.py` | Bundled stdlib Python kernel CEC helper; used only with native remote opt-in |
| `current/dist/web` | Built local browser assets |
| `/etc/sendspin-karaoke/environment` | Root-owned, `sendspin-karaoke` group, **0640** environment file |
| `/var/lib/sendspin-karaoke` | Service-owned persistent state, **0750** |
| `/var/lib/sendspin-karaoke/settings.json` | Saved layout, calibration and Ambient selection/slideshow |
| `/var/lib/sendspin-karaoke/ambient` | Private validated upload copies and atomic library metadata; not a static web root |
| `/etc/systemd/system/sendspin-karaoke.service` | Backend unit |
| `~/.config/sendspin-karaoke/chromium` | Desktop user's dedicated kiosk browser profile |

Configure the backend without putting secrets into command arguments or shell
history:

```sh
sudoedit /etc/sendspin-karaoke/environment
sudo systemctl restart sendspin-karaoke.service
```

This is **systemd EnvironmentFile syntax**, not a shell script: use `KEY=value`,
quote values where needed, and do not add `export` or command substitutions.
Do not `source` it, paste it into issues, or use commands that print all environment
variables.

| Variable | Deployment value / purpose |
| --- | --- |
| `HOST` | `127.0.0.1`; keep loopback-only |
| `PORT` | `8787`; launcher and installer health check use this port |
| `STATE_DIR` | `/var/lib/sendspin-karaoke` |
| `DEMO_MODE` | Initially `true`; set `false` after configuring MA |
| `MA_URL` | Your Music Assistant server endpoint, per app configuration |
| `MA_TOKEN` | MA access token, stored only in the protected environment file |
| `MA_PLAYER_ID` | Intended MA player |
| `MA_QUEUE_ID` | Intended MA queue; required along with the other three MA fields in live mode |
| `MA_ALLOW_LYRICS_REFRESH` | `false` by default; opt in to provider enrichment that may refresh/write MA library metadata |
| `CEC_ENABLED` | `false` by default; enable only after reading [CEC](cec.md) |
| `CEC_REMOTE_ENABLED` | `false` by default; persistent native remote input also requires master CEC enabled and live (non-demo) mode |
| `CEC_DEVICE` | Exact connected kernel character device, default `/dev/cec0`; inspect before enabling, `/dev/cec1` supported |
| `CEC_ADAPTER` | Legacy one-shot libCEC COM identifier only; ignored in native remote mode |
| `CEC_ALLOW_STANDBY` | Keep `false`; standby remains unsupported in both transports |

Leave unconfigured optional fields commented out rather than assigning empty strings.
In Music Assistant stable **2.10.2**, `metadata/get_track_lyrics` can refresh and
write library metadata; it is not necessarily a read-only lookup. With
`MA_ALLOW_LYRICS_REFRESH=false`, the app reads existing stored lyrics but blocks
enrichment for library tracks missing both stored plain and timed lyrics. Consequently some songs may
show no lyrics even when an upstream provider could supply them. To permit this
provider enrichment on your installed appliance, explicitly set
`MA_ALLOW_LYRICS_REFRESH=true` in the protected environment file and restart the
service, accepting the possible MA library metadata writes.

These scripts assume the loopback address, port, and state path above. Changing them
requires coordinated launcher/unit/health-check changes; simply changing the
environment file is not a supported installation variant. Do not expose port 8787
on the LAN: local control routes may affect a real TV. Use an SSH tunnel if an
administrator needs remote access.

The service starts at `multi-user.target` after local filesystems, **not**
`network-online.target`: Wi-Fi and MA outages must not block the local UI.
It restarts after failures. Its filesystem is read-only except for the state
directory and private temporary space; capabilities are removed; home directories
are inaccessible. Per-service journal rate limiting is configured with a 30-second
interval and burst of 100 messages (subject to journald's rate-limit policy).
`MemoryMax=512M` caps the backend service and its CEC child
processes, leaving headroom on a 2-GB Pi for the OS and the separate desktop browser.
An out-of-memory termination can trigger a service restart; Chromium is not covered
by this service's memory limit. Normal `video` and `dialout` supplementary groups support
kernel CEC and USB serial adapters respectively. Device access is deliberately not
hidden with `PrivateDevices`; no blanket device chmod, root service, or custom
world-writable udev rule is used. See [CEC permissions](cec.md).

The launcher waits for the local HTTP endpoint, then starts a sandboxed Chromium
kiosk. A per-session lock avoids duplicates, and Chromium is restarted after exit.
No public website or internet connectivity check gates startup. If you need to
exit kiosk permanently, remove its autostart block and log out rather than repeatedly
closing Chromium.

The launcher uses `http://127.0.0.1:8787/?kiosk=1`. Page-scoped boot CSS hides
the pointer over every web control; normal/admin URLs omit the flag and retain
it. This changes neither the labwc desktop pointer nor the Chromium sandbox.
Native browser dialogs and pre-page startup are outside that CSS. Keyboard
focus remains visible. If a pointer remains visible on the Pi, use the
[bounded kiosk diagnostics](kiosk-pointer.md) from SSH or an ordinary admin
browser. They distinguish bootstrap/style/focus reports without changing the
desktop cursor; they are not proof of physical Wayland cursor hiding.
For a stationary native edge cursor, there is also an
[explicit opt-in labwc startup workaround](kiosk-pointer.md#opt-in-to-native-startup-hiding).
It matches only the managed kiosk's `sendspin-karaoke-kiosk` Wayland app ID,
but hides the seat cursor until pointer activity; read that tradeoff before
enabling it. The installer never enables this rule automatically.
Opt-in native CEC navigation uses this explicit kiosk role
and one exclusive browser lease; normal admin tabs never auto-register.
See the [LG/Onkyo native CEC setup](cec.md) for device discovery, enablement,
allowed keys, diagnostics and recovery after an abruptly killed helper.

When upgrading an older kiosk launcher, log out/in once so it restarts with
the new URL. Ordinary UI updates need a browser reload. Closing just Chromium
restarts it inside the old loop.
The managed autostart block is unchanged and follows `current/kiosk.sh`, so
`configure-kiosk.sh` need not be rerun for an existing correctly installed block.

## Verify and update

```sh
systemctl is-active sendspin-karaoke.service
curl --noproxy '*' --fail http://127.0.0.1:8787/ >/dev/null
sudo journalctl -u sendspin-karaoke.service -n 50 --no-pager
```

Check that the display loads while Wi-Fi is disconnected, reconnects to MA after
Wi-Fi returns, and preserves calibration/state after a service restart. These are
hardware acceptance checks, not claims that CI can verify a physical Pi.

For updates, use **[the canonical main-based upgrade guide](upgrading.md)**.
It covers the first move from a detached/feature-only clone and subsequent
updates with one normal-user block. `main` includes the runtime fix, Ambient,
native CEC navigation and scrolling fix. `scripts/update.sh` takes no arguments
and delegates to the installer; it does **not fetch source or build**.

Install and update use the same idempotent procedure. Existing environment values,
state, service account, and desktop configuration are preserved. Both require
the supported system runtime before making changes; neither installs Node/npm.
Each completed
installation has a managed-directory marker; install/uninstall refuse an existing
unmanaged installation root or symlinked root. A shared lock prevents concurrent
install, update, and uninstall operations. Scripts are stored with LF line endings
enforced by scoped Git attributes and invoked explicitly with Bash.
Each completed
release is root-owned; the symlink changes only after dependencies are installed.
The installer restarts the backend and checks the local page. If this fails during
an update, it restores the previous symlink and service unit and attempts to restart
that version. This is a liveness check, not validation of MA authentication or a
state-schema downgrade. It does not roll back state or secrets.

Upload copies/metadata stay in the writable state directory, not `/opt`.
Back up the complete state with the service stopped. Older releases that do
not understand Ambient settings may need their matching pre-upgrade state
backup; deleting new fields blindly is not a supported downgrade.

Old releases are retained for recovery and must be pruned manually once confirmed
unneeded; failed staging releases and the npm cache also consume storage. Inspect
`readlink -f /opt/sendspin-karaoke/current` before deleting any release. For a manual
rollback, follow [the retained-release and matching-unit procedure](upgrading.md#recovery-without-resetting-git).
Do not rerun an old source installer that predates the runtime fix against
NodeSource: its Debian `nodejs npm` request conflicts with bundled npm.
Use the [private backup procedure](upgrading.md#private-backup) before upgrades. Repeated
updates do not duplicate kiosk autostart entries or reset configuration.

## Offline behavior and removal

The app's JavaScript, CSS, and local visual assets are served from `dist/web`;
there is **no runtime CDN requirement** for the kiosk shell/demo. Initial install
and updates require package access. Live playback, lyrics availability, and artwork
still depend on the MA server and its configured providers; offline assets do not
mean every song's data is cached. On a network outage, show the app's connection
state rather than using a captive portal as the kiosk home page.

To remove, first use the checkout as the desktop user:

```sh
bash scripts/configure-kiosk.sh --remove
# If the optional native startup cursor rule was enabled:
/usr/bin/python3 scripts/configure-kiosk-cursor.py --remove
# Log out of the desktop to stop the running kiosk.
sudo bash scripts/uninstall.sh
```

Uninstall stops/disables the backend and removes its unit and `/opt` releases.
It **preserves** `/etc/sendspin-karaoke`, `/var/lib/sendspin-karaoke`, the service
account, OS packages, Chromium profile, and other autostart entries. There is no
automatic destructive purge flag. Remove preserved files manually only after
backing up and deciding whether credentials should be revoked. It sends no TV
standby command and does not reboot. Reinstalling reuses the preserved settings.

See [Wi-Fi recovery](wifi.md) for unattended-operation recovery procedures.
