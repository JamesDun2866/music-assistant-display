# Kiosk startup cursor workaround and diagnostics

The managed launcher opens `http://127.0.0.1:8787/?kiosk=1` in a dedicated
Chromium Wayland profile. Its early bootstrap and page-scoped CSS request
`cursor: none`. Ordinary admin pages without that query retain their pointer.
This does **not** guarantee that labwc hides a native cursor over another
surface, a browser dialog, or before the page receives pointer focus.

**A connected CEC kiosk lease is not proof of foreground compositor focus.**
Likewise, a desktop browser reporting `cursor: none` does not qualify a physical
Pi 4 at 4K60. The diagnostics below gather evidence; they are not a claimed
Wayland cursor cure. For a stationary native cursor at the screen edge, the
explicit opt-in workaround below hides the startup cursor without mouse access.

## Opt in to native startup hiding

**Tradeoff:** only the managed kiosk triggers the rule, but labwc hides the
**whole seat's cursor**. If the kiosk closes or loses focus without pointer
activity, the desktop cursor remains hidden until the next mouse movement,
button, wheel, stylus or supported gesture. Ordinary admin browser launches
do not trigger the rule. Existing page CSS still hides the content cursor
after pointer activity restores compositor visibility.

This uses supported Chromium `--class=sendspin-karaoke-kiosk` to set the
native Wayland app ID, plus an exact labwc `onFirstMap` rule with `HideCursor`.
It does not move the pointer, inject input, affect CEC navigation, change the
HDMI resolution/GPU settings, or install a transparent cursor theme. It is
a startup workaround, not a permanent per-window cursor policy or a repair
for an unproven window-coverage defect. **One user has confirmed the current
Pi setup works as desired after the merged-config correction; verify your
own desktop after enabling it.**

The helper requires installed **labwc >=0.9.7 and Chromium >=152**, matching
the source-verified baseline, and an already installed launcher with the new
app ID. It supports both ordinary XDG per-user config search and the stock
Raspberry Pi **`labwc -m` / `--merge-config`** mode. Genuine custom `-c`/`-C`
paths are still refused rather than guessing which file to modify. Keep the
desktop session running while enabling over SSH, so the helper can detect
its actual merge mode; absent or conflicting desktop sessions fail safely.
Run as the actual desktop user, never with sudo.

First update/build/install from `main` using the
[canonical upgrade block](upgrading.md#the-repeatable-update). Enter your
actual public checkout first, for example:

```sh
cd ~/projects/music-assistant-display
```

After that block succeeds, explicitly opt in:

```sh
/usr/bin/python3 scripts/configure-kiosk-cursor.py --enable
```

The helper validates XML before writing, retains all existing XML formatting,
comments and rules, and appends one marked `windowRules` section. labwc appends
rules from multiple sections; existing sections are not replaced. Repeating
`--enable` is a no-op. In **merged mode**, labwc already reads system layers
before the user layer: the helper creates only a minimal user `rc.xml` when
none exists, and never copies or rewrites system defaults. This avoids
duplicating desktop bindings and window rules. Existing user XML is retained.
It also rejects duplicate exact kiosk rules in active system layers before
writing anything. In **non-merged mode only**, a missing user `rc.xml` starts
from the first system config in `XDG_CONFIG_DIRS` (normally `/etc/xdg`) so the
user override does not suppress desktop defaults. With no inherited config,
a minimal root is created. The original bytes are
saved once to `~/.config/labwc/rc.xml.before-sendspin-karaoke-cursor` (under
`XDG_CONFIG_HOME` when set). Symlinked targets, malformed/edited markers,
DTD/entity declarations, non-UTF-8 XML and conflicting exact kiosk rules are
refused. A self-closing root must be expanded to an explicit closing tag
before enabling. Nothing is reset on refusal.

**Activate with one reboot, when ready:**

```sh
sudo reboot
```

This is deliberate ordering for the **new native rule and launcher**, not a
page-CSS workaround: labwc reads the rule at session
startup, then autostart launches a genuinely fresh dedicated Chromium process
with its new app ID. A page reload cannot trigger `onFirstMap`. Restarting the
backend does not restart the browser, and closing only Chromium can leave the
old launcher loop running. A complete desktop logout/login also works only
when it really ends the old launcher and dedicated browser; reboot avoids
accidental old-process/profile reuse. The helper never reboots automatically.
The existing managed autostart entry needs no change or rerun.

After startup, confirm the edge cursor is gone while the kiosk is idle,
CEC arrows/OK still navigate, and moving a mouse on the ordinary desktop
restores a usable pointer. Saved photos, uploads, settings and the protected
service environment are unchanged. A page diagnostic reporting `none` is
still not physical confirmation.

### Undo and recovery

From the same checkout as the desktop user:

```sh
/usr/bin/python3 scripts/configure-kiosk-cursor.py --remove
```

Removal deletes only the exact managed block and retains subsequent unrelated
edits. It does not require the minimum package versions or the installed
launcher, so it also works after downgrading/uninstalling the app. It leaves
the backup and user config in place. A minimal empty user root left after
merged-mode removal does not suppress the system layers; non-merged copied
defaults are retained. Restart the desktop
session (or reboot once) to unload the rule and clear already-hidden seat
state; mouse activity restores current visibility immediately. Removal does
not stop the kiosk or inject that activity. Removing autostart alone does not
remove this separate opt-in rule.

If the block was manually edited, the helper refuses to remove unfamiliar
content. Reconcile just the marked block in `rc.xml` as the desktop user;
do not overwrite later personal changes with the backup. For recovery over
SSH, removal followed by a deliberate reboot does not require a mouse.

## Read the TV page without its mouse

First install current `main` with the [upgrade guide](upgrading.md), then reload
the **TV's browser**, not just the admin tab. Updating restarts the backend but
does not replace JavaScript already running in Chromium. The launcher and
labwc configuration are unchanged by diagnostics alone. If the TV has
already been restarted since this update, do not repeat logout/reboot as a
purported fix.

From an ordinary admin browser through your existing SSH tunnel, open
**Display settings > Kiosk pointer diagnostics > Read kiosk diagnostics**.
Alternatively, paste this one line into the Pi's SSH shell (no sudo):

```sh
/usr/bin/node /opt/sendspin-karaoke/current/dist/server/server/kiosk-diagnostics-cli.js
```

The reader authenticates locally in memory. It prints only the bounded report,
never its session cookie/token, page URL, user content, process arguments, or
environment file. No Chrome remote-debugging port is opened.

Also collect the installed package versions using:

```sh
dpkg-query -W labwc chromium raspberrypi-ui-mods
```

Reports start about two seconds after the new kiosk page loads, then repeat
about every ten seconds. Only explicit `?kiosk=1` pages report; CEC can be off.
At most four recent pages are retained, only in backend memory, for 45 seconds.
Hidden pages can have browser-throttled timers. Age is time since server receipt,
not an assertion that the page is still alive. Authentication prevents unrelated
websites writing reports; these are still browser self-reports, not OS attestation.

| Evidence | Interpretation |
| --- | --- |
| `pages: []` | No recent reporting page. It may still run old JavaScript, lack the kiosk query, be closed/throttled, or have failed to report. This does not prove the pointer cause. |
| More than one page | Multiple explicit kiosk pages reported recently. A recently closed page remains until expiry. Do not kill every Chromium process: ordinary desktop browsers may be running too. |
| `queryEnabled`, `rootPath` | Boolean checks of the launch conditions, not the URL or its other parameters. |
| `bootstrapEnabled: false` | Kiosk query is enabled but the early HTML marker is missing. Investigate bootstrap loading rather than compositor settings. |
| `stylesheetLoaded: false` | The specific kiosk stylesheet has not loaded. |
| `rootCursor`, `bodyCursor`, `centerCursor` | Fixed computed-style samples: `none`, `other`, or `unavailable`. `other` deliberately omits custom cursor URLs. |
| `pointerObserved`, `pointerCursor` | Sample at the last pointer-move position inside this page. No movement means `unavailable`, not proof of failure. Coordinates and element content are not sent. Blur/leave clears this sample. |
| `focused`, `visibility` | Browser document focus/visibility, not an OS foreground-window query. |
| `fullscreenMedia`, viewport dimensions | Browser-reported display mode and CSS pixels, not physical HDMI resolution/refresh rate. Browser kiosk fullscreen is not the DOM Fullscreen API. |
| `remote` | This page's remote connection status; independent of its pointer styles. |

If the visible TV pointer persists while a fresh focused/visible kiosk report
has all sampled cursors `none`, share that report and the package versions.
That distinguishes a browser/compositor/native-surface issue from simply
missing page CSS. A physical observation of whether the cursor lies over page
content, a native dialog, or a screen edge is still needed; do not infer it
from these samples. No mouse movement is required to collect the report.

## Supported native action and its limits

The upstream [labwc 0.8.3 configuration](https://github.com/labwc/labwc/blob/0.8.3/docs/labwc-config.5.scd)
and [actions](https://github.com/labwc/labwc/blob/0.8.3/docs/labwc-actions.5.scd)
do not provide a `hideCursor` idle option.
[labwc 0.8.4 introduced `HideCursor`](https://github.com/labwc/labwc/blob/0.8.4/NEWS.md).
The [versioned action documentation](https://github.com/labwc/labwc/blob/0.9.7/docs/labwc-actions.5.scd)
explicitly says pointer/stylus activity or touchpad gestures show it again;
the [implementation](https://github.com/labwc/labwc/blob/0.9.7/src/action.c)
changes the compositor seat cursor. It is not a persistent per-window cursor
policy. Check the Pi's installed version rather than assuming Debian and
Raspberry Pi packages are identical.

The opt-in rule is matched by the native Wayland app ID, supported by
[Chromium 152's Linux window initialization](https://github.com/chromium/chromium/blob/152.0.7977.75/chrome/browser/ui/views/frame/browser_native_widget_aura_linux.cc)
and [labwc 0.9.7 window rules](https://github.com/labwc/labwc/blob/0.9.7/docs/labwc-config.5.scd).
The [stock Raspberry Pi launcher](https://github.com/raspberrypi-ui/rpd-metas/blob/30e37dd99c6a7b26c93bb647fcb72c154d308906/wayland/usr/bin/labwc-pi)
uses `-m`. In [labwc's config reader](https://github.com/labwc/labwc/blob/0.9.7/src/config/rcxml.c),
merged layers are parsed least-important first and user-last, with window
rules appended rather than replaced. Matching actions execute in that order;
the managed user rule is appended after existing user rules.
The application does not install a global transparent cursor theme, bind a
desktop-wide shortcut, run X11 `unclutter`, disable GPU acceleration, or inject
mouse/keyboard events. The temporary seat-wide visibility tradeoff above is
explicit; keyboard focus, CEC navigation, photos and saved settings are preserved.
