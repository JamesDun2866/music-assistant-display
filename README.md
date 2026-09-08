# Music Assistant Display

A local Raspberry Pi TV display for artwork, lyrics and offline photographs,
alongside **Music Assistant audio playing through a separate endpoint**. The
documented audio setup uses an Apollo Automation CAST-1, which keeps its stock
ESPHome/Sendspin firmware and 3.5 mm audio output. The Pi supplies HDMI video
over a Wi-Fi network. Opt-in built-in Pi HDMI-CEC lets forwarded LG remote
arrows/OK/Back navigate the kiosk through the Onkyo; no USB dongle is required.
See [safe setup, exact device selection and hardware limits](docs/cec.md).

**Unofficial community integration:** not affiliated with or endorsed by Music
Assistant, Sendspin, Apollo Automation, or the TV/receiver manufacturers.

**No native Sendspin lyrics role is implemented.** This release reads real MA
lyrics by exact track URI and follows the CAST's exact active queue. Timing is
**approximate MA queue synchronization**, not the Sendspin audio presentation
clock or word-level karaoke. No browser audio player is created and no groups
or playback settings are changed.

**Spotify Connect:** when MA reports an external source instead of an active
queue, the display follows that player's title/artist/album and clears previous
queue lyrics. MA 2.10.2's Connect endpoint exposes a source URI, not the current
Spotify track URI, so this path explicitly reports unavailable lyrics rather
than guessing a song. See [external-source limits](docs/music-assistant.md#spotify-connect-and-external-sources).
Direct Spotify cover URLs require the separate, default-off
[`MA_ALLOW_SPOTIFY_ARTWORK` opt-in](docs/music-assistant.md#optional-spotify-connect-artwork).

**Start here: [complete Raspberry Pi installation walkthrough](docs/installation-guide.md).**
From shopping list and Wi-Fi setup to anonymous public cloning, MA credentials,
desktop kiosk and recovery, including optional HDMI-CEC and **model-checked
Onkyo TX-NR6100** HDMI-video/CAST-analog-audio routing.

**Optional UCA222 line-in and recording:** the separately installed
[native Sendspin source service](docs/uca222-source.md) sends a USB stereo
input to MA 2.10.2 Live Inputs, with its own pairing and boot service.
The display, CAST output and HDMI setup stay unchanged. Optional
[local FLAC/WAV recording](docs/uca222-source.md#optional-flacwav-recording)
starts only on explicit request, including without MA playback, and stops
after five continuous seconds below the silence threshold without rearming.
Recording is off by default; there are no recording controls in the display UI.
Analogue input does not supply track identities or lyrics.

**Optional line-in album identification:** the source can use
[ShazamIO to identify an album once per audible session](docs/uca222-source.md#optional-album-identification-behavior-and-limits).
Recognition is disabled on fresh installations and requires separate optional
dependencies and explicit enablement. It remembers the owner's enable/disable
choice across service restarts. Select the independent **Line-in album** view
for cover art on the left and the matched catalog album's tracklist on the right,
without replacing Now Playing, Lyrics or Ambient. Five seconds of silence
rearms recognition without clearing the last identified album. The cached album
survives failed matches and reboots until another album is identified.
**Retry identification** requests a fresh attempt without starting capture or
recording. This unofficial online integration has no availability guarantee,
may identify a different album edition, and does not provide track-following
or synchronized lyrics. Upgrade both source and display from public `main`;
repeat `--with-recognition` on each source install to retain the optional extra.

**Current `main` is the pre-colour release.** It includes source 0.6.0,
the journal, edition correction, Vinyl mode and high-resolution artwork, but
no artwork-matched colour UI or extraction. Existing saved colour preferences
are accepted without effect. See the [main-based upgrade guide](docs/upgrading.md).

**Dedicated Vinyl view:** a saved, cover-first line-in display with optional
full tracklist, subtle stereo meters and idle-fading controls. It keeps the
last identified album separate from live source status and never follows
Music Assistant's current track. See [Vinyl mode and saved preferences](docs/vinyl-mode.md).

Line-in and corrected-edition covers retain up to 1200 x 1200 pixels, with
aspect ratio preserved and no artificial enlargement of small source images.
Existing thumbnail caches upgrade without discarding their offline image.
See [album artwork quality and resource limits](docs/album-artwork.md).
An [alternate catalog fallback](docs/album-catalog-fallback.md) uses MusicBrainz
and same-release Cover Art Archive covers when Apple metadata is unavailable.
Only corroborated exact catalog relationships apply automatically; uncertain
releases need preview and confirmation. **Retry album metadata** uses the
cached identification, without sampling audio again.

The local [identification journal and edition correction](docs/journal-and-editions.md)
add 90-day dated album history with export/confirmed clear, and explicit
artist/album search, complete-edition preview and remembered correction.
The journal records identifications, not plays or listening duration; original
history stays unchanged by later corrections.

**Source tools (source 0.6.0):** the separate **Tools** panel provides passive
stereo RMS/sample-peak meters, a completed-recording library with private
display labels and confirmed album sidecars, and health with a sanitized
diagnostic download. Audio files remain unchanged; no recording controls or
capture ownership are added. See [setup and privacy limits](docs/source-tools.md).

## A music-first TV interface

The original dark Now Playing interface puts large album artwork, track/artist/
album metadata and elapsed/remaining progress beside the music. Choose **Now
Playing**, **Lyrics**, **Split**, **Ambient**, or **Vinyl**; the selection persists on the Pi alongside
your visual offset. Split is the default, with artwork and synchronized lyrics
both visible. Missing or untimed lyrics never make the artwork view unusable.

**Ambient** is independent of MA: **34 locally bundled native 4K photographs**
by Romain Guy, including genuine-original upgrades of four
Chromecast archive photos, plus a private JPEG/PNG upload library with a saved static/slideshow
selection. Use it for records or CDs without detecting or controlling those
sources. The kiosk URL hides the pointer; normal browsers keep it for managing
images through an SSH tunnel. See [Ambient setup and limits](docs/display.md#ambient-a-quiet-screen-for-any-music).
All 34 are **3840x2160 without upscaling**, with small library thumbnails
(58.07 MiB total, no runtime Internet/download step).
The collection has individually verified CC0 permissions and photographer
credits; the archive's MIT code license does not license all its photographs.
See [photo sources and permission evidence](docs/background-credits.md).
Full 4K detail requires an actual 3840x2160 desktop/HDMI output; a 1080p desktop
still displays a downsampled view and may be smoother for lyrics on a Pi 4.
Existing selections/uploads remain; re-upload originals for old 1080p uploads.

**Already installed? Use the [repeatable main-based upgrade guide](docs/upgrading.md)**,
including migration from an older checkout. `main` includes Ambient,
native remote navigation, and **Smooth / Instant
(low-cost)** lyric following. See [rendering modes and limits](docs/scrolling-performance.md).

The display remains a **visual companion**: live play/pause is a status, not a
fake playback button. Music still plays through the CAST and is controlled in
Music Assistant. The clearly labelled demo alone has local transport controls.
No Spotify account, externally hosted media, new playback permissions, or Pi audio
output are required. See [display controls and screenshots](docs/display.md).

![Now Playing with original synthetic album artwork](docs/images/now-playing.png)

## Run the synthetic demo now

Requires Node.js **22.12+ (below 27)** and npm:

```sh
git clone --branch main --single-branch https://github.com/JamesDun2866/music-assistant-display.git
cd music-assistant-display
npm ci
npm run build
npm run preview:demo
```

Open **http://127.0.0.1:8787**. The clearly labelled local simulator exercises
timed, plain and missing lyrics, pause, seek and next in the real renderer.
It needs no MA, CAST, Internet assets or credentials. CEC is disabled in demo
mode. On Windows PowerShell use `npm.cmd` if execution policy blocks `npm.ps1`.

## Connect Music Assistant

Copy `.env.example` to `.env`, provision `MA_URL` and `MA_TOKEN`, then run
`npm run discover`. Configure the exact `MA_PLAYER_ID` and `MA_QUEUE_ID`;
rerunning discovery with the player ID shows its current active queue.
Set `DEMO_MODE=false`, build, and run `npm start`.

MA **2.10.2 / API schema 65** is the source-verified baseline. Embedded lyrics
work with the default conservative policy. To retrieve missing library lyrics,
review and explicitly enable `MA_ALLOW_LYRICS_REFRESH=true`: MA's lyrics
endpoint can enrich/write library metadata. See [MA setup and compatibility](docs/music-assistant.md).

## Deploy on the Pi

For a fresh installation, follow the
[complete step-by-step guide](docs/installation-guide.md) rather than this summary.

Supported baseline: **Pi 4/5, 2 GB+ RAM, Raspberry Pi OS Trixie Desktop 64-bit,
labwc/Wayland, Chromium**, HDMI, adequate power and reliable Wi-Fi. Use a
desktop installation, not Lite, for the local kiosk.

Provision supported **system** `/usr/bin/node` and `/usr/bin/npm` first:
[runtime setup and Node 20 recovery](docs/installation-guide.md#3-install-the-system-tools-and-check-node).
A successful nvm build is not enough. The installer checks before changes and
does not install Debian Node/npm or overwrite a supported runtime.

```sh
# In your public clone on the Pi, as your normal desktop user:
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
bash scripts/check-runtime.sh &&
/usr/bin/node /usr/bin/npm ci &&
/usr/bin/node /usr/bin/npm run build &&
sudo bash scripts/install.sh
sudoedit /etc/sendspin-karaoke/environment
sudo systemctl restart sendspin-karaoke
bash scripts/configure-kiosk.sh
```

Provision desktop autologin and Wi-Fi yourself as described in the deployment
guide. No script changes Wi-Fi credentials, automatically reboots, or requests
CEC wake/input/standby. An already enabled native listener can register its
playback identity after the installer restarts the service. It only acknowledges
a later TV broadcast selecting the Pi's exact physical path; it does not seize
the input at boot. See [manual CEC selection and diagnostics](docs/cec.md).
The backend starts before network availability and reconnects.
Chromium starts with the desktop session. All browser assets are served locally.
For a stationary native edge cursor, the [opt-in labwc workaround](docs/kiosk-pointer.md#opt-in-to-native-startup-hiding)
supports stock Raspberry Pi **`labwc -m`** without duplicating system defaults.
It requires labwc >=0.9.7 and Chromium >=152; enabling it temporarily hides the
whole seat cursor until pointer activity. It is never enabled automatically.

The UI is **loopback-only**, with same-origin/CSRF protections. For remote
administration, use an SSH tunnel, not a public/LAN bind. A positive visual offset
shows lyrics earlier; the offset persists across restarts. CEC wake/input are
explicit buttons on the same owned transport when remote input is enabled;
the narrow solicited manual-selection acknowledgement needs no startup flag.
Standby is deliberately unsupported; ordinary admin tabs do not consume remote keys.

## Guides

- [Complete installation walkthrough, including optional Onkyo routing](docs/installation-guide.md)
- [Optional UCA222 native Sendspin source and FLAC/WAV recording](docs/uca222-source.md)
- [Move Music Assistant from Home Assistant to Docker/Dockge](docs/music-assistant-migration.md)
- [Upgrade from main, private backup and recovery](docs/upgrading.md)
- [Local LRC lyrics through Music Assistant](docs/local-lyrics.md)
- [Architecture and timing/failure states](docs/architecture.md)
- [Native install, update, rollback, uninstall and recovery](docs/deployment.md)
- [Wi-Fi onboarding and reliability](docs/wifi.md)
- [USB/native HDMI-CEC requirements and limitations](docs/cec.md)
- [Security, credentials and local access](docs/security.md)
- [Future native Sendspin integration checklist](docs/future-integration.md)

## Development and qualification

```sh
npm run typecheck
npm test
npm run build
```

Tests cover parsing, clocks, cache/state persistence, real WebSocket protocol
exchange against a synthetic MA server, reconnect/track changes, rendering,
HTTP control security and injected CEC failures. CI runs on Linux and Windows
with Node 22/24. Song fixtures use original synthetic lyrics.

The independent source package has Linux CI on Python 3.12/3.13, covering
capture lifecycle, paired Sendspin protocol exchange, local recording and
private Unix-socket controls. See its [setup guide](docs/uca222-source.md).
One user reports live multiroom input and local recording working on their
Pi/UCA222 setup; this is not a latency measurement or broad hardware guarantee.

**Limited hardware confirmation:** one user has reported the current Pi setup
working as desired after the stock merged-config cursor correction. This is
not a hardware compatibility matrix or a measurement of lyric timing. Qualify
your own MA providers, audio endpoint, Wi-Fi, HDMI mode and CEC route; there is
no promise of sample-accurate synchronization or universal TV compatibility.

## Project name and license

The public project is [JamesDun2866/music-assistant-display](https://github.com/JamesDun2866/music-assistant-display).
Installed service/account names, `/opt`, `/etc`, `/var/lib` paths and the kiosk
profile deliberately retain **`sendspin-karaoke`** to preserve existing
deployments. This is one application, not a second side-by-side service.
The optional capture component similarly retains **`sendspin-karaoke-source`**
for its Python package, CLI, service and paths. It is a separate opt-in service,
not a replacement for the display.
The public repository starts with fresh history; an older checkout with
unrelated history must not be pointed at it and force-updated. See
[migration and updates](docs/upgrading.md).

Project code is [MIT licensed](LICENSE). Third-party photographs remain
**CC0 1.0**, not MIT; keep their [individual credits and evidence](docs/background-credits.md).
See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency and asset scope.
