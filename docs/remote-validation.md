# Remote navigation software qualification

This is **simulation evidence, not LG/Onkyo/Pi hardware qualification**.
`tests/remote-browser.mjs` starts the real compiled Express/React application on
its own loopback port 8792, with an injected in-process `RemoteSource`, synthetic
track data and a temporary state directory. It never constructs the native
controller, opens `/dev/cec*`, contacts MA, or exposes an input-injection HTTP
route. Attempting an outbound power control fails the fixture.

## Reproduce

Build normally, then run with an existing Chrome installation:

```powershell
npm.cmd run build
node tests\remote-browser.mjs C:\path\to\private-artifacts
```

On another platform set `CHROME_PATH` to an existing compatible Chrome/Chromium
executable. The script uses the already-installed `ws` package and CDP; no
browser-driver dependency or downloaded browser is needed. It uses a dedicated
temporary profile, fails if port 8792 is occupied, closes only its own browser
and server, and removes its temporary profile/state. Screenshot/assertion output
is retained at the specified path (default: the OS temporary directory's
`sendspin-remote-browser-artifacts`).

## Covered browser behaviors

The runner records the exact assertion names in `assertions.json`. Scenarios:

- Real view-tab directional focus, focus-only versus OK activation, and admin
  focus isolation despite shared persisted view changes.
- Scene/settings open and Back focus restoration; directional calibration
  control selection and persisted visual offset, with no playback command.
- Suppression of repeated OK; fresh source and backend connection epochs with
  refreshed authorization and no replayed activation/focus movement.
- Hidden Ambient first-key reveal-only semantics, kiosk cursor hiding versus
  normal admin pointer, and actual controlled slideshow/dwell editing and saving.
- Focused library scrolling and directional escape, admin-only file selection,
  and preserved Ambient/calibration while the synthetic MA connection is lost.
- 1920x1080, 1280x720 and 390x844 viewport overflow and Back/scene-panel behavior.

Independent scenarios seed focus through CDP before delivering normalized
remote actions. This distinguishes action/focus behavior from claiming that
every possible geometric path on every TV has been physically exercised.
Remote actions travel through the actual authenticated kiosk POST stream and
real shared navigation handler, not synthetic browser keyboard events.

Screenshots written by the run:
`remote-settings-1080.png`, `remote-library-1080.png`,
`remote-library-720.png`, and `remote-library-mobile.png`.

## Other gates

Vitest covers the typed Node supervisor, normalized kernel packets,
press/release/repeats/timeouts, routing/source/address checks, stream output
bounds (including forward/backward wall-clock corrections), subprocess
lifecycle, command concurrency, authentication/CSRF/role
checks, competing leases, renewal expiry/backpressure and frontend parser/
navigation behavior. Existing display, migration, upload, MA and deployment
coverage remains enabled.

`python3 -I -B tests/native_cec_test.py` uses only injected device/ioctl/poll
fixtures. On Linux its mandatory compiler test builds `tests/native_cec_abi.c`
against **installed `<linux/cec.h>`** and compares structure sizes, alignment,
field offsets, ioctls and flag values. Missing compiler/header or mismatched ABI
fails Linux CI. Windows skips only that compiler comparison; Windows ctypes
results alone are not reported as Linux ABI proof.

Only a deliberate [hardware qualification](cec.md#4-qualify-keys-step-by-step)
can establish real HDMI registration, EDID/HPD behavior, LG key forwarding,
receiver pass-through, Wayland boot behavior and vendor power-policy effects.
