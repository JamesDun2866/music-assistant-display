# Complete installation walkthrough

This guide takes a new Raspberry Pi from an empty microSD card to a Wi-Fi karaoke
display. **Music Assistant (MA) plays audio through your existing Apollo CAST-1.
The Pi supplies the screen, not the audio.** Keep the CAST's stock firmware.
There is no Spotify login, Pi audio player, or requirement for the draft Sendspin
lyrics protocol.

**Already have the display and want to capture records/CDs with a UCA222?**
Use the [separate USB line-in and optional recording guide](uca222-source.md).
It adds an opt-in service alongside this display without reinstalling the Pi
or moving Music Assistant. The steps on this page install the display only.

The optional receiver chapter is for **TX-NR6100 only: check the rear-panel/model
label first**. Skip that chapter if the label differs or you prefer your
existing speakers.

The software and browser have been exercised locally. **Your Pi, Wi-Fi, MA
account/providers, CAST, TV, receiver and CEC adapter still require hardware
qualification.** The timing source is approximate MA queue timing, not the
Sendspin audio presentation clock. A fixed offset can help, but cannot remove
variable network or processing delay.

## Route through this guide

1. [What to buy and prepare](#1-what-to-buy-and-prepare)
2. [Install Raspberry Pi OS and Wi-Fi](#2-install-raspberry-pi-os-and-wi-fi)
3. [Install the system tools and check Node](#3-install-the-system-tools-and-check-node)
4. [Clone the public repository](#4-clone-the-public-repository)
5. [Build, install and check the synthetic demo](#5-build-install-and-check-the-synthetic-demo)
6. [Connect your real Music Assistant queue](#6-connect-your-real-music-assistant-queue)
7. [Enable the desktop kiosk](#7-enable-the-desktop-kiosk)
8. [Choose the view and calibrate lyrics](#8-choose-the-view-and-calibrate-lyrics)
9. [Optional: Onkyo TX-NR6100 routing](#9-optional-onkyo-tx-nr6100-routing)
10. [Optional: HDMI-CEC](#10-optional-hdmi-cec)
11. [Operate, back up, update and remove](#11-operate-back-up-update-and-remove)
12. [Troubleshooting and acceptance checks](#12-troubleshooting-and-acceptance-checks)

**Command conventions:** unless explicitly marked otherwise, commands run in a
terminal **on the Pi**, logged in as the normal desktop user you create below,
not a root shell. `sudo` appears only where administration is needed. Run blocks
in order, inspect their results, and stop if a command fails. Commands use Linux
Bash syntax; do not paste the Pi setup blocks into your Windows terminal.
Values described as placeholders must be replaced, never used as credentials.

## 1. What to buy and prepare

| Item | Requirement / advice |
| --- | --- |
| Raspberry Pi | Pi 4 or Pi 5, **2 GB RAM minimum**; more RAM gives desktop/build headroom |
| Power supply | A good model-appropriate supply; preferably the official Pi 4 or Pi 5 supply respectively, not an underpowered TV USB port |
| Storage | Quality microSD, preferably 32 GB or larger, plus a card reader; keep space for builds and retained releases |
| Display cable | Pi 4/5 use micro-HDMI: obtain the appropriate micro-HDMI-to-HDMI cable for your TV or receiver |
| Case/cooling | Suitable case and cooling, especially for a Pi 5; do not enclose it tightly behind a hot receiver |
| Network | Working Wi-Fi at the final TV location, Internet for initial packages, and a route to MA; **no Ethernet required** |
| Recovery/input | Keyboard and mouse for first setup/recovery; optionally a USB/Bluetooth remote that presents keyboard keys |
| Existing audio | CAST-1 with its normal power supply, already working in MA, and your existing amplifier/speakers |
| Optional remote input | Built-in Pi HDMI-CEC through Onkyo to LG; no USB dongle required. TV/receiver basic-key forwarding must be qualified on your actual models |
| Optional Onkyo cable | Stereo **3.5 mm TRS-to-two-RCA** line-audio cable, only for the receiver routing below |

Use **Raspberry Pi OS Trixie (Debian 13), Desktop, 64-bit**, with its default
**labwc/Wayland** desktop. The installer requires `trixie` and `arm64`.
Raspberry Pi OS Lite, 32-bit images, Bookworm/older desktop instructions, LXDE
autostart and legacy X11 recipes are not the supported installation.

Start with the simplest wiring:

```text
Music Assistant -- network / Sendspin audio --> stock CAST-1 --> existing speakers/amplifier
       |
       +-- Wi-Fi / queue metadata + lyrics --> Raspberry Pi -- HDMI --> TV
```

The diagram's Wi-Fi link carries app data; the Pi-to-TV video connection is a
physical HDMI cable. Select that HDMI input manually. CEC is not required for
any of the installation, demo or live-display steps.

## 2. Install Raspberry Pi OS and Wi-Fi

On your **other computer**, install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
Select your Pi model, the Trixie Desktop 64-bit image, and the correct microSD.
**Writing the image erases that card.** In Imager's customization, configure:
your own username/password, a hostname such as `karaoke-pi`, Wi-Fi SSID/password,
the correct Wi-Fi country, locale/timezone, and SSH if wanted. Prefer SSH
public-key authentication; keep any password strong. There is no assumed `pi`
username or default password.

Insert the card, connect HDMI and a keyboard/mouse, then power the Pi. Complete
first boot and confirm the desktop and Wi-Fi work. Use the desktop network menu
to correct Wi-Fi if needed; no Ethernet onboarding step is required. Do not put
Wi-Fi credentials in this repository or application configuration.

For SSH from your **other computer**, replacing `your-user` and the hostname:

```sh
ssh your-user@karaoke-pi.local
```

Verify the host-key fingerprint using the Pi/local setup before accepting a new
SSH host. If `.local` is unavailable, find the Pi's IP in the router or desktop.
A DHCP reservation helps keep it reachable.

On the **Pi**, check the image, network and clock:

```sh
grep '^VERSION_CODENAME=' /etc/os-release
dpkg --print-architecture
nmcli device status
timedatectl status
timedatectl show -p NTPSynchronized --value
```

Expect `VERSION_CODENAME=trixie`, `arm64`, a connected Wi-Fi device and, after
network time settles, `yes` for `NTPSynchronized`. Keep network time enabled on
**both the Pi and MA host**. If needed, enable automatic time using the Pi's
date/time settings and investigate its NTP/network access; an offset is not a
substitute for a correct system clock.

Guest/client isolation, captive portals and separate VLANs can block MA despite
working Internet. `.local` discovery generally needs multicast DNS; across VLANs,
use working router DNS or a reserved MA IP. MA-to-CAST discovery/audio is separate
from Pi-to-MA WebSocket access. See [Wi-Fi onboarding and recovery](wifi.md).

## 3. Install the system tools and check Node

The app needs **Node 22.12.0 or later, but below 27**. Node 22/24 are the CI
matrix. **Trixie's Debian packages can supply Node 20.19.2, which is too old.**
A successful build using `nvm` does not prove that the system service can run:
the service uses **`/usr/bin/node`**, not your interactive shell's Node.

On the **Pi as the normal desktop user**, inspect both runtimes. These diagnostic
commands may fail if no system runtime exists; in that case provision it below:

```sh
type -a node npm
/usr/bin/node --version
/usr/bin/node /usr/bin/npm --version
```

Install the clone/download tools whether or not you need to change Node:

```sh
sudo apt update &&
sudo apt install -y git openssh-client curl ca-certificates
```

If `/usr/bin/node` already meets the range and can run `/usr/bin/npm --version`,
keep that runtime; **skip the NodeSource repository changes**. The corrected
installer validates both before creating its lock, installing packages, or
changing accounts/releases/state. It never installs `nodejs` or the separate
Debian `npm` package.

### Provision system Node 24 with NodeSource if needed

This is an **explicit third-party APT repository choice**, not a Raspberry Pi OS
package or an action performed automatically by this app. It affects other
system Node applications and future APT updates. NodeSource's `nodejs` package
includes npm and conflicts with Debian's separate `npm`; **install `nodejs`
alone, never `nodejs npm` together**.

The current NodeSource 22/24 setup scripts accept Debian-based `arm64` systems
and configure the `nodistro` suite; both publish ARM64 packages. This provides
a concrete provisioning path for the Trixie ARM64 target. Their older published
support table stops at Debian 12, so this is script/package-source verification,
**not a claim of vendor-certified Trixie support or a tested Pi installation**.
Review APT's proposed resolution on your actual machine before accepting it.

Download the Node **24** setup script as your normal user, outside the checkout.
Do not use the moving `setup_lts.x` / `setup_current.x` aliases and do not pipe
downloaded code directly into a root shell:

```sh
mkdir -p "$HOME/node-setup" &&
curl --fail --show-error --location --proto '=https' \
  https://deb.nodesource.com/setup_24.x \
  --output "$HOME/node-setup/nodesource_setup_24.sh"
```

**Stop if the download fails.** Display and inspect the saved script before
deciding to execute it:

```sh
cat "$HOME/node-setup/nodesource_setup_24.sh"
```

It installs prerequisites, imports NodeSource's signing key, configures its
repository and package priority, and replaces existing NodeSource source/key
configuration. Preserve any customized repository configuration before this
step. Only if you accept those changes, run it explicitly (no `sudo -E`):

```sh
sudo /bin/bash "$HOME/node-setup/nodesource_setup_24.sh"
```

If it reports an error, stop. Inspect the candidate and a **simulation**:

```sh
apt-cache policy nodejs
sudo apt-get --simulate install nodejs
```

Expect a **24.x NodeSource** candidate, not Debian 20.x. Review removals,
including any conflicting Debian npm/development packages. Stop if unrelated
software would be removed, packages are held/broken, or the candidate is wrong;
do not force overwrites, use wildcard removals or run `autoremove` as a shortcut.
After reviewing the proposal, install interactively:

```sh
sudo apt-get install nodejs
```

Do **not** separately install Debian `npm` afterwards. If you intentionally
prefer Node 22, use `setup_22.x` and a correspondingly named saved script in
the same download-inspect-run procedure, and check for a 22.x candidate of at
least 22.12.0. Keep an already working supported 22/24 runtime rather than
switching repositories unnecessarily.

### Verify the exact runtime the installer uses

```sh
/usr/bin/node --version
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || a>=27 || (a===22 && b<12)) { console.error("Unsupported system Node: need >=22.12.0 and <27"); process.exit(1); } console.log("Supported system Node");'
/usr/bin/node /usr/bin/npm --version
sudo /usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/node /usr/bin/npm --version
```

**Stop if any verification fails.** Do not symlink `/usr/bin/node` into an nvm
home directory, bypass the version guard, or weaken the engine requirement.
The install/update scripts pin a system-only PATH and invoke npm through
`/usr/bin/node /usr/bin/npm`, so npm's `#!/usr/bin/env node` shebang cannot pick
up a different personal runtime. The backend also explicitly starts
`/usr/bin/node`; its service PATH does not inherit your login's nvm settings.
Do not add personal `PATH`, `NODE_OPTIONS` or `NODE_PATH` overrides to the
service environment file.

The native build blocks below also select a system-only PATH for that terminal;
your nvm installation is not removed. After cloning, the read-only
`bash scripts/check-runtime.sh` command repeats the appliance's actual preflight
without sudo or package changes.

**Recovering from "Vite build succeeded, then install rejected Node 20"?**
Provision/verify the system runtime above, then use the
[main-based upgrade procedure](upgrading.md) for your existing checkout.
It obtains current source before calling scripts missing from older clones.
For a first installation follow sections 4-5. Do not rerun an older installer that
still requests `nodejs npm`. This failure happened before the new release was
activated; preserve any existing environment/state rather than uninstalling
or deleting them. There is no need to reflash the SD card.

Sources checked: [NodeSource distribution instructions](https://github.com/nodesource/distributions/blob/master/DEV_README.md),
[Node 24 setup](https://deb.nodesource.com/setup_24.x),
[Node 22 setup](https://deb.nodesource.com/setup_22.x), and their
[24 ARM64 package index](https://deb.nodesource.com/node_24.x/dists/nodistro/main/binary-arm64/Packages)
/ [22 ARM64 package index](https://deb.nodesource.com/node_22.x/dists/nodistro/main/binary-arm64/Packages).

## 4. Clone the public repository

Clone anonymously over HTTPS as the **normal Pi desktop user**. No GitHub
account, token, repository invitation or deploy key is needed. SSH login to
your Pi is separate from access to this public source. Never put credentials
in a clone URL or disable TLS verification.

```sh
mkdir -p "$HOME/projects" &&
cd "$HOME/projects" &&
git clone --branch main --single-branch \
  https://github.com/JamesDun2866/music-assistant-display.git &&
cd music-assistant-display &&
git branch --show-current &&
git rev-parse HEAD
```

`$HOME/projects` is an example location; use the same actual checkout in later
commands. Keep it for updates/removal. It is not the installed runtime.
For an existing clone of this public repository, use the
[upgrade guide](upgrading.md) instead of cloning again.

The public repository has **fresh history**. To move an existing installation
from an older, unrelated source checkout, keep that checkout/remote intact and
follow the upgrade guide's migration instructions. Do not force-merge histories.
The project name is Music Assistant Display, but the installed
`sendspin-karaoke` service, account, paths and kiosk profile are intentionally
unchanged so existing state and credentials are preserved.

## 5. Build, install and check the synthetic demo

On the **Pi, normal user, inside the checkout**:

```sh
cd "$HOME/projects/music-assistant-display"
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
bash scripts/check-runtime.sh &&
/usr/bin/node /usr/bin/npm ci &&
/usr/bin/node /usr/bin/npm run build &&
sudo bash scripts/install.sh
```

Do not run `npm ci` or the build with sudo. The native installer takes **no
arguments**. It first requires a supported system Node/npm, then installs only
the other OS runtime packages, creates the unprivileged
`sendspin-karaoke` service account, installs a versioned release under `/opt`,
and enables/restarts the backend. It does not change Wi-Fi, desktop autologin,
TV settings or audio routing, and does not reboot.

On a fresh install the protected configuration deliberately selects **demo mode
and CEC off**. An existing installation retains its settings instead. Check:

```sh
systemctl is-active sendspin-karaoke.service
curl --noproxy '*' --fail http://127.0.0.1:8787/healthz
curl --noproxy '*' http://127.0.0.1:8787/readyz
sudo journalctl -u sendspin-karaoke.service -n 50 --no-pager
```

Open **http://127.0.0.1:8787** in Chromium on the **Pi desktop**. Expect an
explicit demo label, original synthetic artwork/lyrics, and demo controls.
Try its pause, seek and next controls: timed, plain and missing lyrics should
all leave a useful display. **The demo makes no sound** and proves neither a
real MA connection nor CEC hardware operation.

For a view from your **other computer**, keep this SSH tunnel open:

```sh
ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 your-user@karaoke-pi.local
```

Then open **http://127.0.0.1:8787** on that computer. If its local port 8787 is
already occupied, use `127.0.0.1:8788:127.0.0.1:8787` in the tunnel and browse
port 8788 instead. This is administrator access, including explicit TV controls
if you later enable them. Do not forward the port publicly, change the app to
`0.0.0.0`, or browse `http://PI-IP:8787`; the service is intentionally loopback-only.

## 6. Connect your real Music Assistant queue

First use **MA's own interface** to confirm music already plays on the intended
CAST and speaker system. This application cannot fix or replace the CAST's
audio connection. Keep the Pi in demo while provisioning.

Source-verified compatibility is **MA 2.10.2 / API schema 65**. This is not a
claim of testing your server; older/incompatible schemas fail explicitly.
See [MA compatibility and API behavior](music-assistant.md).

### Store the MA token once

Create a dedicated **Music Assistant long-lived access token** through MA's
account settings. It is not a Home Assistant token or a Spotify token. Current
MA tokens require eventual rotation; see the MA guide for expiry details.

On the **Pi**:

```sh
sudoedit /etc/sendspin-karaoke/environment
```

Set your actual `MA_URL` and raw `MA_TOKEN` in that editor. Leave
`DEMO_MODE=true` until both IDs have been discovered. Do not prefix the token
with `Bearer`. Use the direct MA base URL (commonly port 8095), not an HA ingress
page requiring a browser session; the app adds `/ws`. A reverse proxy must
support WebSocket upgrades.

The final file will have this shape; **the values below are placeholders, not
working credentials**:

```ini
HOST=127.0.0.1
PORT=8787
STATE_DIR=/var/lib/sendspin-karaoke
DEMO_MODE=false
MA_URL=http://music-assistant.local:8095
MA_TOKEN=REPLACE_IN_EDITOR_WITH_REAL_MA_TOKEN
MA_PLAYER_ID=REPLACE_WITH_EXACT_CAST_PLAYER_ID
MA_QUEUE_ID=REPLACE_WITH_EXACT_ACTIVE_QUEUE_ID
MA_ALLOW_LYRICS_REFRESH=false
CEC_ENABLED=false
CEC_REMOTE_ENABLED=false
CEC_DEVICE=/dev/cec0
CEC_ALLOW_STANDBY=false
# CEC_ADAPTER remains commented out until optional CEC setup.
```

Use simple `KEY=value` entries; quote values if necessary, without shell
substitutions or `export`. Never `source` this file. Leave unused optional keys
commented out rather than assigning empty strings. Keep the listed host, port
and state directory: the unit, launcher and installer expect them.

The installer protects the file as `root:sendspin-karaoke`, mode **0640**, inside
a **0750** directory. Inspect permissions without printing secrets:

```sh
sudo stat -c '%U:%G %a %n' /etc/sendspin-karaoke /etc/sendspin-karaoke/environment
```

### Discover the exact player and queue

After saving URL/token, run the installed discovery entry as the service user.
**Change directory as shown** so discovery cannot accidentally load a development
`.env` from your checkout:

```sh
cd /opt/sendspin-karaoke/current
sudo -u sendspin-karaoke /usr/bin/node \
  --env-file=/etc/sendspin-karaoke/environment \
  /opt/sendspin-karaoke/current/dist/server/server/discover.js
```

It lists accessible player and queue IDs/names, not the token. Find the intended
CAST, edit `MA_PLAYER_ID` into the protected file, and rerun **the same discovery
command**. It now also prints `activeQueueId` for that player.

Set `MA_QUEUE_ID` to that **exact activeQueueId**, not a friendly name or a
guessed copy of the player ID. In a group it may be another/group queue ID. If
the value is `null`, establish the desired available player/queue in MA yourself
and rerun discovery; do not enter the string `null`. The bridge does not create
groups, transfer playback or automatically follow an unexpected queue.

Once all four MA fields are correct, set `DEMO_MODE=false`, save, and run:

```sh
sudo systemctl restart sendspin-karaoke.service
curl --noproxy '*' http://127.0.0.1:8787/readyz
```

Play a track using **MA** and inspect the Pi's live title, artist, album, cover
and progress. The UI should no longer be labelled demo. Changing MA groups or
the active queue can intentionally produce a queue-mismatch diagnostic; rerun
discovery and deliberately revise the pinned queue if that new routing is wanted.

**Native configuration versus `.env`:** this walkthrough never needs a checkout
`.env`. `.env.example` / `npm run discover` are for development; the installer
does **not** copy a development `.env`. If you already used one, transfer its
required values through `sudoedit`, remove the redundant local secret copy and
editor backups when no longer needed, and never commit it. Deleting a file is
not secure erasure of flash media; revoke/rotate any exposed token.

### Enable lyrics deliberately

The default `MA_ALLOW_LYRICS_REFRESH=false` reads lyrics already stored on the
track. For missing library lyrics it blocks an enrichment path that can write
MA metadata. Non-library tracks may still use MA's verified lyrics endpoint.
Songs with no lyrics or only plain lyrics remain useful in Now Playing/Split.

If you want the bridge to request missing library lyrics, first review
[MA lyrics providers](https://www.music-assistant.io/metadata/lyrics/) and their
account/availability requirements. Then, **only if you accept MA library
metadata enrichment**, set `MA_ALLOW_LYRICS_REFRESH=true` with `sudoedit` and
restart the service. This does not install a provider or guarantee synchronized
lyrics. Authentication/provider/image reads can also update MA activity/caches;
the default is not a promise of zero server-side writes.

For your own local music, follow the [local LRC how-to](local-lyrics.md). Place
lyrics where **MA's local music provider** can read them, not in a new Pi upload
directory. The bridge follows the actual queue track URI, never a title search.

## 7. Enable the desktop kiosk

Do this after the page works in ordinary Chromium. In the Pi's **Control Centre**
or `sudo raspi-config`, choose **desktop autologin for the intended user** if you
want unattended startup. Console autologin is insufficient. This gives anyone
with physical access an unlocked desktop; use an appropriately restricted
appliance account, protect SSH, and reconsider autologin on a shared computer.

Screen blanking is a separate OS setting. Disable it manually only if desired;
consider TV burn-in/power policy for long static displays. The app does not
disable the TV's own sleep timer.

In a terminal **as that same desktop user, without sudo**:

```sh
cd "$HOME/projects/music-assistant-display"
bash scripts/configure-kiosk.sh
```

The script preserves existing labwc autostart entries and inserts one managed
launcher block. It saves the original first version as
`~/.config/labwc/autostart.before-sendspin-karaoke` and is safe to repeat.
It neither starts a new desktop nor changes autologin.

When ready, **log out of the desktop and log back in**. Alternatively, choose
to reboot via the desktop power menu after saving your work. Reboot is an
operator choice, not an installation requirement or automatic script action.
With desktop autologin, a subsequent normal boot should launch Chromium.

The launcher requires the real labwc/Wayland session, waits for the local
backend and restarts its dedicated Chromium if it exits. Do not run it as root,
add `--no-sandbox`, or launch it from an ordinary SSH shell that lacks a desktop
session. To stop the kiosk permanently, remove its autostart block and log out;
repeatedly closing Chromium just triggers a restart.

The backend runs independently of the desktop and Wi-Fi; the browser has its
own user profile at `~/.config/sendspin-karaoke/chromium`. There is no container
or system service trying to run the GUI as root.

The updated launcher opens `http://127.0.0.1:8787/?kiosk=1`, hiding the pointer
throughout the page from initial rendering and on reload. Normal browsers at
the plain URL retain their pointer. Keyboard focus and touch are unaffected.
This does not hide the pointer globally in labwc or native browser dialogs.
For a stationary cursor that remains at the screen edge, see the
[opt-in native startup workaround](kiosk-pointer.md#opt-in-to-native-startup-hiding).
The helper supports stock Pi `labwc -m` without copying system defaults into
the merged user layer. It requires labwc >=0.9.7 and Chromium >=152 and
temporarily hides the whole seat cursor until pointer activity. Run it only
as the desktop user with the desktop session active; keep `-m` and do not
bypass a configuration refusal. Reboot deliberately once after successful
enablement to load the rule before a fresh kiosk map.
Opt-in [native CEC remote navigation](cec.md) uses this same explicit kiosk URL;
ordinary admin/tunnel pages never auto-register for remote input.

**Upgrading an older kiosk launcher:** follow the [upgrade guide](upgrading.md),
then log out and back into the desktop once. Ordinary UI updates only need a
browser reload. The existing managed autostart block already launches
`/opt/sendspin-karaoke/current/kiosk.sh`; **you do not need to rerun
`configure-kiosk.sh`** if it is present. Closing only Chromium leaves the old
launcher running with its old URL and respawn loop.

## 8. Choose the view and calibrate lyrics

Choose **Now Playing** for the large cover and metadata, **Lyrics** for a
text-first screen, **Split** for both, or **Ambient** for independent backgrounds. The mode and visual offset persist on
the backend across tracks, browser reloads and service restarts.

| Input | Action |
| --- | --- |
| Tab / Shift+Tab; Enter / Space | Move focus and activate a control |
| Direction keys | Navigate controls; Up/Down scroll a focused reading pane; Left/Right leave that pane |
| `F` | Toggle fullscreen |
| `[` / `]` | Decrease / increase lyric offset by 100 ms |
| Escape | Close a panel / reveal Ambient controls |
| `1` / `2` / `3` / `4` from page background | Now Playing / Lyrics / Split / Ambient |

Shortcuts do not override normal editing/scrolling behavior. A keyboard-style
remote can operate these controls. Native Pi CEC can also forward supported
LG arrows/OK/Back into the same real actions after the opt-in setup below.
Live progress/play-pause are indicators; control actual
playback, queue, volume and grouping in MA.

Calibrate with a known, correctly timed track while listening from your normal
seat. Start at zero, then adjust in small increments in display settings:

- Lyrics appear **late** compared with the voice: use a **positive** offset
  (for example `+300 ms`) to show them earlier.
- Lyrics appear **early**: use a **negative** offset to delay them.

The range is +/-30 seconds. It changes visuals only, never CAST audio or the MA
queue. If the error changes continually, check clocks/Wi-Fi/LRC accuracy rather
than increasing the offset. AVR/TV processing can require recalibration.
Plain lyrics cannot become synchronized merely by setting an offset.
See [display details and screenshots](display.md).

### Backgrounds for records, CDs, or a quiet room

Select **Ambient**, then open its background library. **34 native 3840x2160,
individually CC0-cleared Romain Guy photographs** are bundled locally,
including genuine-original upgrades of Golden Gate Afternoon, Lone Pine Sunset,
Rockaway Sunset Sky, and Bonzai Rock Sunset plus 30 more from his portfolio.
All work on first launch without
MA or Internet, defaulting to a 60-second slideshow. Select
the included scenes, show one static scene, or save a slideshow dwell between
15 and 3,600 seconds. Controls hide when idle and reappear with keyboard,
touch, or mouse; Escape returns to controls. Editors and uploads stay visible.
Select a music view to return; MA playback never changes your choice.

On your computer, use the SSH tunnel in section 5 and the plain
`http://127.0.0.1:8787` URL to upload/manage images with a normal pointer.
The library accepts **JPEG/PNG only, 12 MiB per input, up to 32 million pixels
and 16,384 pixels per axis**. The server validates/decodes, auto-orients,
strips metadata and saves a JPEG within 3840x2160 without upscaling.
Other formats, animations, and malformed/oversized images are rejected.
There is a **40-image / 128 MiB stored-copy quota**, including small thumbnails.
Existing selections/uploads survive updates; add new built-ins deliberately
and re-upload originals to replace old 1080p upload copies. Full 4K detail needs
an actual 3840x2160 desktop/HDMI mode; 1080p can remain a smoother Pi 4 choice.
Select uploaded images
and confirm before deleting; built-ins cannot be deleted. Removing the current
image chooses the first remaining included image, or Golden Gate Afternoon if none remain.
See [full image/privacy behavior](display.md#add-your-own-images).

These are individually CC0-cleared photographs, not a claim that the entire
702-entry archive can be redistributed. The archive's code license does not
establish photo rights. Source/license credits and acquisition evidence are in
[photo provenance](background-credits.md). No runtime Google/Flickr feed,
external thumbnails, arbitrary URL importer, or first-download cache is needed.
Previously saved illustrated-scene IDs migrate to this photo collection without
discarding uploaded-image selections, calibration, view, or slideshow settings.

Ambient neither knows the physical song nor switches receiver inputs.
Use your existing CD/record setup manually. If switching an AVR input also
switches HDMI video, the Pi picture may disappear even though Ambient keeps
running. The simplest independent path is **Pi HDMI directly to the TV** while
the physical source uses your existing amplifier. On a confirmed TX-NR6100,
only use an intentional, documented combination of Pi HDMI and the desired
physical audio input, preserving existing assignments. The CAST analog mapping
in section 9 is specifically for CAST audio, not automatic CD/vinyl routing.

## 9. Optional: Onkyo TX-NR6100 routing

**TX-NR6100 only: check the rear-panel/model label first. Do not apply these
menu mappings blindly to another receiver.** If you cannot confirm
the model, skip this chapter and use Pi HDMI directly to the TV, with the CAST
on its existing speakers.

For the TX-NR6100, its official manual documents separately assignable HDMI
and analog inputs and an Analog audio priority. This is a documented routing
option, **not a test on your receiver**. No eISCP, Onkyo input automation or
receiver network control is implemented in this application.

### Before changing anything

Photograph your current cables and the relevant **HDMI Input**, **Analog Audio
Input**, **Audio Select**, input name and HDMI-output settings. Note the
selected input and volume. If BD/DVD or the example jacks are already used by a
disc player, **do not overwrite that mapping**; use the alternative below or
keep direct-to-TV wiring.

Turn the receiver volume down and power equipment off before recabling,
following its manufacturer instructions. Shut the Pi down normally before
disconnecting its power; do not just pull its supply. Leave existing speaker wiring alone.
Use the CAST's **line output**, not a speaker/amplified output.

### Wire the example using available jacks

```text
Raspberry Pi micro-HDMI ---- HDMI cable ----> Onkyo HDMI IN 1
CAST-1 3.5 mm line out -- stereo TRS-to-RCA -> Onkyo AUDIO IN 1 L/R
Onkyo HDMI OUT MAIN -------- HDMI cable ----> TV HDMI input
Onkyo speaker outputs ---------------------> Existing receiver speakers
```

Connect white RCA to left and red to right. **Never use PHONO**: it is a
different input type, not the line-level destination for the CAST. An HDMI-CEC
dongle is not an audio extractor, mixer or substitute for the analog cable.

### Set the receiver manually

For the **confirmed TX-NR6100**, power up, select the TV input connected to the
receiver's MAIN output, and select **BD/DVD** on the receiver. Using its remote
and on-screen Setup menu, configure the following for BD/DVD:

| Menu path | Value |
| --- | --- |
| Setup -> **1. Input/Output Assign -> HDMI Input** | **HDMI 1** |
| Setup -> **1. Input/Output Assign -> Analog Audio Input** | **AUDIO 1** |
| Setup -> **4. Source -> Audio Select** | **Analog**, not the default HDMI priority |
| Optional: Setup -> **4. Source -> Name Edit** | `Karaoke`, then save with OK |

Select the intended receiver input **before editing Source settings**; Audio
Select is per input. If Analog is unavailable, check that the same selector
has an AUDIO IN assignment. HDMI 1 and AUDIO 1 are BD/DVD's documented default
assignments, but a used receiver may differ: explicitly inspect them.
MAIN is the documented default HDMI output; if your display is routed
elsewhere, review **Input/Output Assign -> TV Out / OSD -> HDMI Out** against
your recorded settings and actual cabling.

**Why Audio Select matters:** the Pi app generates no audio. Leaving HDMI
priority can give you a picture but no CAST sound. Analog priority uses the
CAST's stereo signal while the independently assigned HDMI input carries video.
The receiver drives its speakers; the TV does **not** need analog audio
forwarded over HDMI.

**If BD/DVD is occupied:** choose a genuinely unused selector and free HDMI
and AUDIO IN jacks, then assign both to that selector and set its Audio Select
to Analog. Do not assume any particular selector is free. The manual requires
unassigning an HDMI jack from its old selector (`---`) before assigning it
elsewhere. Only do that if the old mapping is unneeded and recorded; otherwise
use another jack. Keep the actual jack numbers consistent with the cables.

### Confirm picture and sound separately

First confirm the Pi desktop/demo appears through the receiver; the demo itself
is silent. Then use MA to play on the CAST. Start at **low receiver volume**,
check that CAST output is neither muted nor excessive, and raise listening
level gradually. Avoid compensating for a very low CAST level with an extreme
receiver setting that could become loud when another input is selected.
Use sensible stereo listening settings initially.

Only after manual audio and video both work should you consider optional CEC.
CEC/ARC policies on the TV or receiver can switch away to TV audio or another
source. ARC is not required for this CAST-to-receiver-speakers route. Record
settings before changing them, and return to manual input selection while
diagnosing. The app does not automatically select BD/DVD or rename a receiver
input.

This combines two signal paths; it **does not synchronize the lyric clock**
more precisely. Recheck the visual offset after any AVR/TV processing changes.

### Restore your previous setup

Turn volume down and power off before restoring the photographed cables.
Restore every changed selector's HDMI assignment, analog assignment, Audio
Select, input name and any changed HDMI-output/CEC/ARC setting from your notes.
Where an HDMI jack was reassigned, first release it from the temporary selector
before restoring its old assignment. Select the original source and check it at
low volume. Do not factory-reset the receiver to undo this one optional setup.
No Pi application change is needed to return to direct-to-TV video.

### Official TX-NR6100 references

These paths and defaults were checked against the actual official manual, not
assumed from another Onkyo model:

- [Official TX-NR6100 manual PDF](https://assets.onkyo-av.com/product-manuals/SN29403926A_TX-NR6100_En_200616_web.pdf.pdf):
  HDMI Input **p. 111**, Analog Audio Input **p. 112**, Name Edit and Audio
  Select **pp. 121-122**. Analog Audio Input is submenu **4** under
  Input/Output Assign; Audio Select is named under Source.
- [Onkyo Input / Output Assign support article](https://support.onkyousa.com/hc/en-us/articles/10406557616276-TX-NR6100-Setup-Menu-Input-Output-Assign)
  and [official owner-manual page](https://support.onkyousa.com/hc/en-us/articles/19977386451348-TX-NR6100-Owner-s-Manual).

## 10. Optional: HDMI-CEC

Leave CEC off until normal HDMI video and CAST audio are reliable. Then follow
the complete [native Pi -> Onkyo -> LG setup and recovery guide](cec.md).
**No USB dongle is needed**. The new listener uses the exact `/dev/cecN` kernel
node; it does not depend on libCEC 7's `/dev/cec0`-only native path selection.
The installer supplies its stdlib `python3` runtime and packaged helper.

Start with read-only device/permission discovery and `--probe` as documented.
Confirm the actual connected node, LG SIMPLINK settings, Onkyo model and route.
LG behavior varies by model; apply TX-NR6100-specific HDMI OUT MAIN guidance
only if that model is confirmed. Do not enable additional power-linking policies.

In the existing protected environment, set `CEC_ENABLED=true`,
`CEC_REMOTE_ENABLED=true`, `CEC_DEVICE=/dev/cecN` (replace `N` with the discovered node number), and keep
`CEC_ALLOW_STANDBY=false`. Real input requires `DEMO_MODE=false` and valid live
configuration; MA itself may be offline. Restart the backend, then log out/in
to run exactly one `?kiosk=1` page. This opt-in claims a playback address and
enables normal CEC identification replies, without startup wake/active-source/standby.
While listening, an exact TV-origin broadcast Set Stream Path can solicit an
Active Source acknowledgement. This preserves manual selection, sends no extra
wake, and needs no startup flag. Generic/ancestor routes and reconnects do not
authorize it; vendor power/routing effects and missing key forwarding remain
possible. See [the bounded routing and navigation diagnostics](cec.md#diagnostics-bus-lease-then-ui).
Explicit Wake / Use this input buttons share the same transport, and may affect
TV policy. Standby remains unsupported even if its flag is changed.

Basic forwarded arrows move focus, OK activates, and Back closes panels safely.
The first key with hidden Ambient controls only reveals/focuses controls; release
and press again to act. TV Home/Settings/volume/power and Magic Remote pointer
or voice are not mapped. Select upload files in the ordinary admin browser.
Only the explicit kiosk role consumes remote input, through one expiring lease;
normal administration tabs are unaffected and must omit `?kiosk=1`.

Use CEC status/last-allowed-key and `kioskConnected` diagnostics to separate
missing forwarded keys from a missing browser lease. Listening is not proof of
LG compatibility. A direct Pi -> TV cable is a diagnostic to isolate the AVR,
not a reason to buy a dongle if the TV never forwards keys.

Graceful stop releases this helper's address. Abrupt process loss can leave
kernel registration behind: the app refuses to take over an existing registration
and reports degraded status with operator recovery instructions. Transient
disconnections use bounded listening retries, never replay queued power actions.
To disable, set both CEC flags false and restart. Physical audio/video routing,
Onkyo setup and TV power remain manual.

## 11. Operate, back up, update and remove

### Everyday health and recovery

These commands run on the **Pi**, from any directory:

```sh
systemctl is-active sendspin-karaoke.service
curl --noproxy '*' http://127.0.0.1:8787/healthz
curl --noproxy '*' http://127.0.0.1:8787/readyz
sudo journalctl -u sendspin-karaoke.service -n 50 --no-pager
df -h / /var
```

`healthz` means the backend is alive; it does not establish MA readiness.
`readyz` reports connection/queue readiness and can return HTTP 503 while
unavailable. Missing lyrics, a silent speaker or a failed TV request still
require their own checks. Review logs before sharing them and never publish
environment files, private keys, tokens or listening history.

An installed kiosk can load its local assets before Wi-Fi connects. On upstream
loss it freezes then clears stale playback rather than leaving old lyrics/cover
apparently live; it reconnects and reanchors when connectivity returns.
A service restart is `sudo systemctl restart sendspin-karaoke.service`; it
briefly interrupts visuals, not the CAST's independent MA audio path.

### Private backup before updates

Use the [private backup block](upgrading.md#private-backup): it keeps configuration,
complete state (including settings and Ambient uploads) and the service unit
together in root-private storage, and restarts the backend even if archiving
fails. Record the installed release too. Older schemas may require that matching
pre-upgrade state backup; do not blindly overwrite newer state or credentials.

### Update from main

Use **[the single repeatable main-based upgrade block](upgrading.md#the-repeatable-update)**
as your normal desktop user in your actual public checkout. It handles detached
and feature-only clones of the public repository as well as local `main`, and
refuses dirty/ahead/diverged local work. Unrelated older project histories
require the separate-clone migration described in that guide.
It fetches current source, checks system Node/npm, builds, then runs the installer;
`scripts/update.sh` alone neither fetches nor builds. Private configuration and
uploads persist. The guide covers browser refresh, release identity and health
versus MA readiness; no reboot is required.

### Roll back deliberately

Follow [recovery without resetting Git](upgrading.md#recovery-without-resetting-git)
to select the recorded retained release and its matching unit while stopped.
Code rollback does not downgrade state or secrets. Do not run an old installer
that predates the system-runtime fix, restore tokens blindly, or wipe settings.

Old releases, state backups and npm caches consume storage. Inspect them before
manually pruning; uninstall does not purge private state.

### Uninstall

First, **as the desktop user without sudo**, in the retained checkout:

```sh
cd "$HOME/projects/music-assistant-display"
bash scripts/configure-kiosk.sh --remove
# If you enabled the optional native cursor rule:
/usr/bin/python3 scripts/configure-kiosk-cursor.py --remove
```

Then **log out of the desktop** to stop its existing kiosk process. From SSH
as your normal user (or a non-kiosk login), run:

```sh
cd "$HOME/projects/music-assistant-display"
sudo bash scripts/uninstall.sh
```

This stops/disables the backend and removes its unit and managed `/opt`
releases. It **preserves** `/etc/sendspin-karaoke`, `/var/lib/sendspin-karaoke`,
the service account, OS packages, your checkout, Chromium profile and unrelated
autostart entries. There is no `--purge` option. Reinstallation reuses the
preserved configuration, which may be live rather than demo.

For disposal, separately revoke the MA token and device SSH access, decide what
private backups/state to retain, and follow a suitable storage-erasure procedure.
Uninstall sends no TV standby and does not undo manual Onkyo/TV settings.

## 12. Troubleshooting and acceptance checks

| Symptom | Check first |
| --- | --- |
| Unsupported OS/Node or Vite succeeds but install fails | Confirm `trixie`, `arm64`, Desktop/labwc, and **system** `/usr/bin/node` in range with usable `/usr/bin/npm`; follow section 3 rather than installing Debian Node 20 or bypassing guards |
| Public clone fails | Check the exact HTTPS repository URL, Internet/DNS and TLS trust; no GitHub token or deploy key is required |
| Build/install fails | Read the first error; check free space, Internet/package access and supported Node. Build as normal user before sudo installer |
| Local page absent | Service status/journal, `/healthz`, fixed port 8787 and environment permissions; do not run a second preview server on the same port |
| Page works but no boot kiosk | Desktop autologin, actual labwc session, autostart configured for the **same user**, not root/SSH; closing Chromium alone restarts it |
| Authentication or schema error | MA token, expiry, URL and verified version; HA tokens/ingress browser URLs are not interchangeable with MA API access |
| Connecting / stale / timestamp error | Wi-Fi/AP isolation, DNS, WebSocket reverse proxy and NTP on both hosts; check `/readyz` and [Wi-Fi recovery](wifi.md) |
| Wrong queue / no track | Rerun discovery with exact CAST player ID; check its `activeQueueId`, availability and current group in MA |
| No lyrics / plain text | Check the exact track in MA, configured provider and enrichment policy; plain text has no clock. See [local lyrics](local-lyrics.md) for sidecars and cache delays |
| Cover placeholder / missing album | MA must supply metadata and a supported raster image through its proxy. No cover is legitimate; SVG/HTML/redirects are rejected. Do not paste upstream image/token URLs into the UI |
| Lyrics consistently early/late | Adjust visual offset with the sign rules above; confirm correct song/version, LRC timestamps and AVR/TV processing |
| TV blank / clipped desktop | Manually select HDMI, check cable/power/port and OS display resolution/TV overscan. Start with a conservative 1080p mode; test direct Pi-to-TV before adding receiver/dongle |
| Video but no receiver sound | CAST playing/unmuted in MA, RCA connected to AUDIO IN (never PHONO), correct per-input analog assignment and **Audio Select = Analog** on confirmed TX-NR6100 |
| Audio but no app sound on Pi | Expected: the Pi app never plays audio. Diagnose CAST/MA/receiver instead of enabling a Pi audio player |
| CEC absent/busy/ignored | Adapter discovery as service user, correct connector/path, permissions, competing client, TV/AVR CEC settings; retry explicitly or disable it |
| TV/AVR switches away | Return to manual selection; inspect recorded CEC/ARC policies. No receiver input automation is implemented |

Before relying on the appliance, perform these **on your own hardware** with a
local recovery path: confirm cold boot reaches the desktop/kiosk; play, pause,
seek and change tracks in MA; confirm the selected CAST's metadata follows;
check plain/missing lyrics and artwork; verify settings survive a service
restart; and test Wi-Fi loss/recovery without losing your only administration
connection. The screen should freeze/clear, reconnect and reanchor, not show
old-track lyrics as live. CEC must not wake, switch or turn off anything merely
because playback/network/service state changes.

Keep CEC and optional receiver routing out of the first acceptance pass. Add
one at a time only after the basic Pi display plus existing CAST audio works.
For deeper operational details use [deployment](deployment.md),
[security](security.md), [architecture](architecture.md) and the
[future Sendspin integration checklist](future-integration.md).
