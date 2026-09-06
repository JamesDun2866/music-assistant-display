# LG remote navigation through the Pi's built-in HDMI-CEC

**Opt-in, disabled by default. No USB adapter is needed for this path.**
The supported software route is Pi 4/5 built-in CEC -> HDMI -> Onkyo -> LG TV.
The TV/receiver must actually forward basic remote keys to the Pi's playback
address. Listening successfully does **not** prove that a particular LG model
will forward them. No physical TV, receiver, Pi, or Music Assistant equipment
was operated during development.

The Pi remains HDMI visuals only; CAST remains the audio endpoint. There is no
audio player, receiver automation, source detection for CDs/records, unsolicited
wake/input takeover, or standby. `CEC_ALLOW_STANDBY=true` still cannot enable
standby. Opening an enabled listener registers a playback identity and allows
normal kernel CEC identification replies, **without startup power or active-source
requests**. A received TV broadcast selecting this Pi's exact physical path can
now solicit one **Active Source acknowledgement**, without an extra wake command.
TV/receiver CEC policy can still have its own power-linking or routing effects.

<a id="install-this-dependent-feature"></a>

## Install from main

Native remote navigation is on `main`, alongside the runtime, Ambient and
scrolling fixes. Use the [canonical upgrade procedure](upgrading.md), including
for an old detached/feature clone. For first install follow the
[installation guide](installation-guide.md) for MA and desktop setup.
The existing system Node/npm preflight is unchanged. The installer adds normal
`python3`, not an npm FFI/native compilation dependency. Production still uses
`--omit=dev --ignore-scripts`, with the Python helper copied into
`dist/server/server/native-cec.py` by the build and installed with `dist`.

## 1. Inspect the connected kernel device (read-only)

On the intended Pi, leave CEC disabled while identifying the HDMI connector:

```sh
ls -l /dev/cec*
ls -l /sys/class/cec/
dpkg-query -W cec-utils libcec7
id sendspin-karaoke
udevadm info --query=path --name=/dev/cec0
```

Substitute the actual node in the last command. Pi HDMI ports may expose
`/dev/cec0` and `/dev/cec1`; do not assume port numbering. Inspect each candidate:

```sh
sudo -u sendspin-karaoke /usr/bin/python3 -I -u \
  /opt/sendspin-karaoke/current/dist/server/server/native-cec.py \
  --device /dev/cec0 --probe
```

`--probe` opens read-only and queries capabilities, physical address, configured
logical addresses, and flags. It does **not** set mode, claim addresses, transmit,
or change TV routing. `physicalAddress` is a decimal EDID-derived address:
`65535` is invalid/missing HDMI hotplug/EDID. Never guess or set a physical
address. A configured logical address may belong to another client or be left
behind by an abruptly killed client; the probe cannot prove ownership.

The node must be an exact `/dev/cecN` character device, not a symlink, USB COM
alias, or path traversal. The service uses its existing `video` group for kernel
CEC; `dialout` is retained for optional legacy serial adapters. Check actual
device permissions. Do not grant `input`, run the service as root, use
`chmod 666`, or globally grab `/dev/input`. Restart the service after a legitimate
group/udev correction by the administrator.

## 2. Prepare the LG/Onkyo route manually

First confirm normal HDMI video through the receiver and CAST audio work with
CEC off. Record existing HDMI/CEC settings and keep a keyboard/SSH recovery path.

Enable **SIMPLINK (HDMI-CEC)** using the manual for the actual LG model/webOS year.
[LG's official guide](https://www.lg.com/us/support/help-library/lg-tv-how-to-use-hdmi-cec--20153207563544)
shows different menu locations by year. Enabling CEC may also affect power linking;
do not enable additional auto-power/standby options just to use this application.
Use the instructions for your specific LG model.

The Onkyo must pass CEC on the selected Pi HDMI input to the TV. **Confirm its
exact model** on its rear-panel label. For a confirmed
TX-NR6100 only, the
[official Hardware menu documentation](https://support.onkyousa.com/hc/en-us/articles/10394861928852-TX-NR6100-Setup-Menu-Hardware)
says HDMI CEC is effective through **HDMI OUT MAIN**, and changing the setting
requires a deliberate off/on cycle of connected devices. This application does
not do that for you. Other models require their own manual.

Select the Pi video route manually. Receiver analog-audio/HDMI-video assignment
remains a manual, model-specific choice; see the installation guide. Switching to
CD/phono may remove Pi video unless the receiver supports the chosen combination.
CEC does not move CAST audio to HDMI or tell the app what record is playing.

Visible Pi video after manual AVR input selection does not necessarily make the
Pi the TV's **CEC active source**. The native listener now acknowledges a real
TV-origin broadcast **Set Stream Path (`0x86`)** selecting its exact verified
EDID path, so normal manual selection can establish the remote destination.
It does not react to an ancestor path (for example the receiver's path), an AVR
or other source pretending to select it, or **Request Active Source (`0x85`)**.
If the LG/Onkyo route never forwards that exact TV request, this change cannot
fix forwarding by itself. Inspect the bounded diagnostics below during a
deliberate manual selection before attempting more TV controls.

The optional **Use this input** button in the plain admin URL's Display settings
remains a separate, deliberate override. This explicitly
sends **Active Source** and may switch TV/receiver routing (or trigger their
power-linking policy). Use it only while present and ready for that change; it
is never sent merely because of startup or reconnect.

## 3. Opt in and open exactly one kiosk page

Edit the protected existing configuration, without printing MA secrets:

```sh
sudoedit /etc/sendspin-karaoke/environment
```

```ini
CEC_ENABLED=true
CEC_REMOTE_ENABLED=true
CEC_DEVICE=/dev/cecN
CEC_ALLOW_STANDBY=false
DEMO_MODE=false
```

Replace the `/dev/cecN` placeholder with the node discovered above. Keep the valid live MA configuration and
`DEMO_MODE=false`: demo mode always disables real CEC, even if both flags are true.
MA may be offline; native input and Ambient do not depend on MA readiness.
`CEC_ADAPTER` is **ignored** while the native remote transport is selected.

```sh
sudo systemctl restart sendspin-karaoke.service
systemctl is-active sendspin-karaoke.service
sudo journalctl -u sendspin-karaoke.service -n 50 --no-pager
```

Restarting with the opt-in flags claims a playback logical address (4, 8, or 11)
and begins listening. Starting alone sends no wake/active-source/standby;
the solicited exact-path acknowledgement above is the only new exception once
listening. Log out/in to restart
the existing desktop launcher at **`http://127.0.0.1:8787/?kiosk=1`**.
An existing correctly installed autostart block needs no reconfiguration.
Closing only Chromium leaves its old launcher loop running.

Use the **plain URL without `?kiosk=1`** for administration or SSH-tunnel uploads.
Only an explicit kiosk page attempts to acquire the exclusive remote lease.
Two kiosk tabs cannot both consume input; close the unwanted page or wait up to
30 seconds for its expired lease. A normal admin page cannot automatically steal
the lease or navigate when keys arrive.

This is an explicit-role trust boundary, **not proof of physical presence**:
both a Pi browser and an SSH tunnel appear loopback. A trusted user deliberately
opening `?kiosk=1` through a tunnel can acquire an otherwise vacant kiosk lease.
Do not use that URL for normal administration.

## 4. Qualify keys step by step

| Forwarded key | Kiosk action |
| --- | --- |
| Up / Down / Left / Right | Move real focus; Up/Down scroll a focused reading pane |
| OK / Select | Activate the focused permitted control |
| Exit / Back (`0x0d`) | Close an open panel and restore focus, or return safely to view controls |
| First key with hidden Ambient controls | Reveal controls and focus the current view tab **only**; release, then press again to act |

Only TV logical address 0 or AVR address 5 targeting this instance's claimed
playback address is accepted. Media Backward (`0x4c`) is **not** UI Back.
Power, volume, digits, vendor messages, Magic Remote pointer/voice, Home and
Settings are not mapped; they remain TV/receiver functions. A TV may consume
even the basic keys rather than forwarding them.

Direction repeats are limited, with an initial hold delay; actions depend on
actual repeat packets rather than a free-running synthetic key timer. OK/Back
never repeat while held. Hold/repeat timing uses monotonic elapsed time, not
the Pi's NTP-adjusted wall clock; diagnostic timestamps remain normal epoch
timestamps. Release, input timeout, route change, transport loss
and kiosk-session loss clear or suppress held input. No key history is replayed
after a browser or backend reconnect. Release the key after reconnect before
trying again. Focus remains visible while the kiosk cursor stays hidden.

Verify view switching, display settings/calibration, Back, and Ambient image
selection/slideshow without affecting music playback. **Choose upload files in
the admin browser**: browser-native file dialogs cannot be driven by these
application events. Browser fullscreen also requires trusted user activation;
the installed Chromium kiosk is already full screen.

## Diagnostics: bus, lease, then UI

Display settings show the CEC transport/lease, most recent routing event and
acknowledgement result separately from the most recent allowed navigation key. For a
read-only JSON diagnostic that excludes MA credentials:

```sh
curl --noproxy '*' --fail --silent http://127.0.0.1:8787/api/state |
  /usr/bin/python3 -I -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["cec"], indent=2))'
```

Inspect `available`, `message`, and `remote`: `enabled`, `listening`, `device`,
`logicalAddress`, `physicalAddress`, `lastEvent` (allowed key/time only), and
`kioskConnected`, plus optional `lastRouting`. `owned` remains false: exclusive adapter ownership does not
prove ownership of the TV's active route.

`lastRouting` is one bounded record, not a bus log: `id`, `opcode`, `source`,
`target`, `physicalAddress` (operand, when present), fixed `decision` and
`acknowledgement` values, and epoch-millisecond `at`. Completion updates retain
the event ID/time and cannot replace a newer event. It is cleared for a new
listener session. `lastEvent` still means only the last accepted navigation key,
never a routing frame. In Display, compare the routing event/time **while you
deliberately select the Pi**:

* No new routing event: no qualifying routing traffic was observed; this does
  not prove which device failed to forward it.
* `0x86` with `wrong-source`, `wrong-target`, `wrong-length` or `wrong-path`:
  no acknowledgement is authorized. The Pi requires TV logical 0, broadcast 15
  and its exact current physical path, not an ancestor or guessed path.
* `matched` with `sent`: the kernel confirmed transmission, **not** that the TV
  switched, accepted the Pi as active, or forwards keys. Try a released, fresh
  arrow key and look for `lastEvent` changing.
* `pending`, `failed`, `suppressed` or `cancelled`: do not assume success.
  Duplicate/busy responses are not queued; failed/cancelled replies never replay.
  Inspect listening/registration status before another deliberate selection.

* Not listening: inspect the precise missing-device/permission/busy/EDID/address
  diagnostic. Listening is never inferred from process startup.
* Listening, no new `lastEvent` when pressing supported keys: check LG forwarding,
  SIMPLINK, Onkyo route and actual destination/device. This is not yet a UI problem.
* `lastEvent` advances but `kioskConnected=false`: check the exact kiosk URL,
  browser visibility, another kiosk tab, and local service connection.
* Connected with new allowed events: first hidden-Ambient key is intentionally
  consumed; then inspect visible focus. An ordinary admin tab is intentionally
  not a remote consumer.

With permission to change your cabling, **direct Pi -> LG TV** is a diagnostic
to isolate the receiver: stop the listener, safely move HDMI, inspect the new
EDID/device, then enable again. If keys work directly but not through the Onkyo,
investigate its CEC route. If neither forwards keys, use keyboard input and check
the actual LG model's capabilities; buying a USB dongle is not a forwarding fix.
TV off/deep sleep/HPD loss can remove EDID; the listener cannot operate without
a valid physical address. Explicit wake can also be unavailable then.

## Recovery and disable

Graceful shutdown clears only this helper's registration while it still owns
the exclusive adapter filehandle. Linux **retains adapter configuration after
file/process close**. A SIGKILL, service OOM, or cleanup failure can therefore
leave an address behind. The app cannot prove that an existing “Sendspin”
registration is stale or exclusively its own, and never clears it automatically.

An existing-registration/cleanup failure is a **degraded, not-listening state**,
not a successful reconnect. Stop this service and any specifically identified
other CEC application. Use the read-only probe again. If registration remains,
save work and deliberately restart **the Pi** to clear kernel adapter state
before retrying; do not factory-reset, power-cycle, or auto-control the TV/AVR.
There is no automatic registration-stealing command. Already submitted
kernel transmissions may finish after abrupt process death; they are never
queued for replay by the new helper.

Missing devices, invalid EDID and transient transport loss use bounded backoff.
Configuration/unsupported/permission/protocol/ambiguous-registration errors need
operator correction and a service restart. Outbound actions fail rather than
waiting to surprise you after reconnect.

An `adapter-removed` error is retryable only when read-only kernel interrogation
proves the old adapter is unregistered (`ENODEV`) and its filehandle closes
successfully. Failed cleanup alone is not that proof. The replacement helper
still refuses any existing registration on the newly opened device.

To disable navigation, set `CEC_REMOTE_ENABLED=false`; set **`CEC_ENABLED=false`**
as well to disable all CEC. Restart the service and use a keyboard/admin browser.
No TV standby, input change, MA action, or reboot is sent by disabling it.

## Transport, limits and sources

`NativeCecController` owns one `/usr/bin/python3 -I -u` stdlib helper with a
minimal fixed environment, no shell, no credentials or loader-injection
variables. It uses direct Linux UAPI, not CLI log parsing, and fixed allowlisted
outbound messages for explicit Wake / Use this input and the strictly solicited
exact-path Active Source acknowledgement. The same owned transport
handles input and commands: there is no competing one-shot libCEC process.
It has bounded lines/output windows, startup/command deadlines, pending commands,
and shutdown escalation. The unprivileged service's existing 512 MiB cgroup
covers the helper; there are no extra capabilities or `input` group access.

The kernel mode is **exclusive initiator + normal exclusive follower (`0x22`)**.
Kernel core identity/version replies remain enabled. The registration leaves
`CEC_LOG_ADDRS_FL_ALLOW_RC_PASSTHRU` **clear (flag value 2)** and verifies it, so
rc-core cannot inject a second keyboard action alongside the app's received
packet. Only receive packets with sequence 0, no transmit status and valid
receive status can become input; transmit completions/replies cannot.

Route acknowledgement is authorized **inside that one native receive owner**,
not by a delayed Node command derived from a status snapshot. It drains received
frames before dispatch, processes adapter state and revalidates registration
at transmission. A final nonblocking readiness probe after registration checks
suppresses the reply if new bus/state/stdin work appeared (or the probe was
interrupted). A route-away, competing Active Source, standby, inactive-source
or transport reset cancels unsent authorization. Held keys are suppressed and
the existing kiosk lease reconnects automatically; release and press again
rather than reloading the page. A receive backlog, duplicate burst or busy
command path suppresses the reply instead of scheduling a later takeover.
Duplicates coalesce only within a completely drained receive batch; a sliding
two-second monotonic quiet period bounds later requests. No timer or reconnect
creates a reply, and pending UI transmissions take precedence.
Once CEC_TRANSMIT has accepted a frame, a later bus event cannot retract it;
this is not a guarantee against subsequent TV/vendor routing policy.

Kiosk registration and renewals are CSRF-authorized POSTs tied to a session,
per-page ID and one connection. Keys use a separate ephemeral POST event stream,
not `/api/events` snapshots. A fresh random epoch and monotonic sequence reject
duplicates; old events expire, stream buffers are bounded, and page hiding,
disconnect or lost renewal ends the lease. No production synthetic-input API
exists.

With `CEC_REMOTE_ENABLED=false`, the existing explicit-only one-shot
`CecController` remains available: `cec-client -s -d 1 -t p -aw 0 [adapter]`,
stdin `on 0` or `as`, no standby, 16 pending/12-second/64-KiB limits.
`-aw 0` is libCEC's USB auto-power setting, **not a universal no-power guarantee**.
The trailing argument is a COM identifier; `-p` is an HDMI port number.
Trixie's libCEC 7.0.0 native backend opens compile-time `/dev/cec0`; do not
promise that giving it `/dev/cec1` selects that node. Native remote mode avoids
this packaged limitation and does not parse nonexistent key-press callback logs.

Source-checked contracts (2026-09-05):

- [Linux v6.12 CEC UAPI](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/cec.h):
  ctypes layouts/ioctls are compared against installed Linux headers in CI.
- [Modes/core replies](https://docs.kernel.org/userspace-api/media/cec/cec-ioc-g-mode.html),
  [logical addresses/RC flag](https://docs.kernel.org/userspace-api/media/cec/cec-ioc-adap-g-log-addrs.html),
  [receive/transmit semantics](https://docs.kernel.org/userspace-api/media/cec/cec-ioc-receive.html),
  [poll](https://docs.kernel.org/userspace-api/media/cec/cec-func-poll.html),
  [close retains configuration](https://docs.kernel.org/userspace-api/media/cec/cec-func-close.html).
- [Debian Trixie cec-utils 7.0.0](https://packages.debian.org/trixie/cec-utils),
  [libCEC 7 native path](https://github.com/Pulse-Eight/libcec/blob/libcec-7.0.0/src/libcec/adapter/Linux/LinuxCECAdapterCommunication.cpp),
  [libCEC 7 client callbacks](https://github.com/Pulse-Eight/libcec/blob/libcec-7.0.0/src/cec-client/cec-client.cpp).
- [Linux v6.12 core receive handling](https://github.com/torvalds/linux/blob/v6.12/drivers/media/cec/core/cec-adap.c#L2027-L2231)
  and [VC4 adapter](https://github.com/torvalds/linux/blob/v6.12/drivers/gpu/drm/vc4/vc4_hdmi.c):
  normal follower identity replies do not implement this route acknowledgement.
- [v4l-utils 1.30.1 exact-path follower behavior](https://github.com/gjasny/v4l-utils/blob/v4l-utils-1.30.1/utils/cec-follower/cec-processing.cpp#L376-L390)
  informs the conservative reply. This app advertises CEC 1.4; a CEC 2.0
  compliance rule is not proof of a CEC 1.4 violation.

Hardware-free Python ioctl fixtures, Linux header ABI checks, Node child-process
fakes, HTTP lease tests, frontend tests and simulated browser input do not
qualify actual Pi/Onkyo/LG forwarding or vendor power policies.
See [reproducible software qualification](remote-validation.md) for the exact
browser runner, assertion output, screenshot names and Linux ABI gate.
