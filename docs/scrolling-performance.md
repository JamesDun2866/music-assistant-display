# Lyric scrolling and Pi qualification

Rendering pauses are different from late lyrics. Use the visual offset for a
stable timing difference, not to compensate for jerky movement or brief freezes.
The display offers **Smooth** and **Instant (low-cost)** following without
changing the lyric clock, audio endpoint, native 4K photographs or HDMI mode.

One user has reported the current Pi setup working as desired after the
merged-config cursor correction. That limited confirmation is not a benchmark
or a guarantee for every Pi, track, receiver, TV or compositor version.

## Choose the low-cost mode

Open **Display settings > Lyric follow > Instant (low-cost)** using the remote
or an ordinary admin browser through an SSH tunnel:

```sh
ssh -N -L 127.0.0.1:8788:127.0.0.1:8787 your-user@karaoke-pi.local
```

Open **http://127.0.0.1:8788** without `?kiosk=1`. The setting is saved on the
service and broadcast to connected displays. No physical mouse, Chromium flag
change or output-mode change is required.

**Smooth remains the default**, including when migrating older settings.
Instant uses `scrollTo({ top, behavior: "instant" })`, removes lyric color
transitions and the viewport mask, and keeps active font weight the same as
neighboring lines. Accent color, font size, full text, accessibility and
intro/instrumental cues remain. Reduced motion uses the same low-cost path
and interrupts an existing smooth follow when the preference changes.

Focus, wheel, touch or click in the timed pane pauses automatic following and
cancels in-flight movement. Up/Down, including held remote keys, scrolls the
focused reading pane; Left/Right leaves it. Cue changes, seeks and resizes
continue updating the active cue without recentering while reading.
**Resume lyric follow** centers the latest cue once. Track/generation changes
and leaving the lyric view reset this browser-local reading pause.
Plain lyrics remain manually scrollable.

## Rendering mechanism and limits

The renderer retains up to 4,000 lyric paragraphs. Equal lyric arrays are
shared across accepted snapshots within the same track/generation/status,
after schema and sequence checks, so heartbeat updates do not cause redundant
lyric reconciliation or follow calls. Other metadata and clock anchors still
update. Revised lyrics and track/generation changes are not hidden.

A common rectangle coordinate system centers the active line. Resize observers
handle viewport/content changes and deduplicate unchanged geometry. Cleanup
prevents superseded observers from following newly committed lyrics.
There is no JavaScript animation loop or virtualized/truncated lyric list.

Instant removes continuous animated travel, not all frame costs. Mounting a
long track, rewrapping and updating thousands of paragraph classes can still
take time. Smoothness on a desktop cannot establish performance on the Pi's
GPU, Wayland compositor, receiver or TV at 4K60. The launcher uses Wayland
without disabling the GPU or adding unsafe acceleration overrides.

## Reproduce software qualification

Use the existing Node dependencies and an installed Chrome/Chromium:

```sh
npm ci
npm run build
node tests/scrolling-browser.mjs /path/to/artifacts --verify
node tests/scrolling-browser.mjs /path/to/smooth-4k --4k --verify
node tests/scrolling-browser.mjs /path/to/instant-4k --4k --instant --verify
node tests/scrolling-browser.mjs /path/to/instant-lyrics-4k --4k --lyrics --instant --verify
```

Use your own output paths (Windows paths and `npm.cmd` on Windows).
`CHROME_PATH` selects an existing browser; no browser download is needed.
Run one invocation at a time. The fixture uses a dedicated temporary browser
profile and synthetic HTTP/SSE server at **127.0.0.1:8793**, original generated
lyrics and no real MA connection. It cleans up its own browser/profile/server,
not other running instances.

The runner exercises 80- and 4,000-cue fixtures at 1x and 4x CPU throttle,
heartbeats, seeks, track/generation changes, resized wrapping, reduced motion,
current-cue centering and manual reading/resume. Throttling is not Pi emulation.
The separate `tests/remote-browser.mjs` exercises authenticated remote/admin
setting propagation using an injected remote source, not physical HDMI-CEC.

Outputs include `summary.json`, scroll/frame samples, Chrome traces, CPU
profiles and screenshots. Keep them outside the checkout and inspect before
sharing: browser profiles and diagnostic artifacts are not release assets.
Measurements include instrumentation overhead; do not interpret CPU trace
durations as GPU utilization or promise a universal speedup.

## Read-only checks on your Pi

Do not share the environment file, tokens or unreviewed diagnostic dumps.
From your source checkout:

```sh
git rev-parse HEAD
git status --short
readlink -f /opt/sendspin-karaoke/current
/usr/bin/node --version
chromium --version
sha256sum /opt/sendspin-karaoke/current/dist/web/assets/index-*.js
```

The checkout SHA is not the running release's identity. Record the selected
release path and compare built/installed hashes using the
[upgrade guide](upgrading.md). The desktop Display Configuration panel or
an already-installed `wlr-randr` in the local desktop can report the current
HDMI mode without changing it; a supported-mode list is not an active mode.

Compare Smooth and Instant on modest and long tracks. Full native photo detail
requires actual 3840x2160 output, but choose a mode appropriate to your equipment.
If investigating GPU behavior, record only the Graphics Feature Status summary
in `chrome://gpu`, not the entire private browsing/system report. Already
available `vcgencmd get_throttled` and `vcgencmd measure_temp` can help identify
power/thermal problems. Do not change launcher/GPU flags merely to make a
desktop benchmark look better. For a persistent native edge cursor, use the
separate [opt-in startup workaround](kiosk-pointer.md).
