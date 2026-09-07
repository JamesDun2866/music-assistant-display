# UCA222 line-in on the display Pi

The optional **sendspin-karaoke-source** service sends a Behringer U-CONTROL
UCA222's stereo input to **Music Assistant 2.10.2** as a native Sendspin Live
Input. It runs alongside the display on the same Raspberry Pi; Music Assistant
can remain on its existing machine. The CAST remains your audio player.

This is a separate, opt-in Python service, not a new mode of the display or an
installation of Music Assistant on the Pi. The display's Node runtime, MA
token, kiosk, HDMI-CEC settings and player/queue configuration are unchanged.
The ordinary display installer does not install or enable audio capture.

The public project is **Music Assistant Display**. The Python package, CLI,
service account and installed paths retain the compatible legacy component
name **`sendspin-karaoke-source`**.

**Qualify your own hardware.** Stable multiroom playback and successful FLAC
recordings have been reported on a real Pi/UCA222 installation using source
0.2.0. Those user observations are not lab benchmarks or universal hardware
qualification; automated coverage does not exercise physical equipment. Start at low speaker
volume and follow the foreground setup before enabling unattended operation.
MA 2.10.2 also marks its Sendspin Source plugin as alpha.
Live input has buffering delay: this is for music distribution, not live
microphone monitoring or a zero-latency karaoke microphone.

## 1. Wire the input

```text
CD player / line-level source --------------------+
                                                 |
Turntable -> phono preamp (if not built in) -------+--> UCA222 RCA INPUT
                  (choose one source)                    |
                                                        USB
                                                         |
                                                     display Pi
                                                       /     \
                                           HDMI to TV         network
                                                                 |
                                                         Music Assistant
                                                                 |
                                                         CAST / MA players
                                                                 |
                                                          amp / speakers
```

Use one source at a time. The drawing does not mean joining two sources'
outputs with a Y cable.

1. Connect the source's **line-level analogue output** to the UCA222's RCA
   **INPUT** sockets: white to left, red to right.
2. Connect the UCA222 USB cable to the display Pi. It gets power over USB.
3. Leave the Pi's HDMI connection and your CAST-to-amplifier connection alone.

A turntable needs a phono preamp with the appropriate cartridge support and
RIAA equalization. Use the turntable's **LINE** setting if it has a built-in
preamp; the UCA222 is not itself a phono preamp. A CD player's analogue line
outputs can connect directly.

**Never connect speaker terminals to the UCA222.** Do not assume an amplifier
has a suitable record output: confirm the exact model and output behavior.
A variable pre-out/headphone output needs careful level adjustment to avoid
clipping; a fixed line output is preferable when compatible with the input.
This guide does not reassign Onkyo inputs or assume the receiver has a
particular output.

The UCA222's RCA **OUTPUT**, optical output and headphone socket are not used
for this capture-to-network route. Its direct-monitor switch is not the
Sendspin enable switch. Avoid listening to a direct analogue path and the
delayed network path in the same room at once: that produces an echo.

## 2. Install the separate service

Supported target: the display's **Raspberry Pi OS Trixie Desktop, arm64, Pi
4/5** baseline. Keep adequate cooling, a reliable power supply and network
connectivity. Nothing here requires reflashing the SD card, replacing the
desktop, installing JACK, or changing the default sound output.

Run these commands **in a terminal on the Pi**, not in Windows PowerShell.
Use a trusted checkout containing `scripts/install-source.sh`; it is not
present in older versions of this project. Do not fetch an unrelated branch
or run the normal display installer in an attempt to get this optional service.

### Install from public main without switching the display checkout

The source and optional recorder are available on public **`main`**.
As your normal desktop user on the Pi, create a separate public source setup
clone. HTTPS cloning requires no GitHub account, token or private-repository
access:

```sh
git clone --branch main --single-branch \
  https://github.com/JamesDun2866/music-assistant-display.git \
  "$HOME/music-assistant-source-setup"
```

This leaves the display checkout's branch and any local edits alone. Run
this creation block only once; if that directory already exists, use the
update procedure below instead of deleting or overwriting it. Do not run
Git with sudo or put access tokens into the command.
An older checkout from a different repository has unrelated history: keep
it and its origin unchanged, and use this new public clone instead. Do not
merge histories, force-reset, or repoint that old checkout at this repository.
The compatible installed paths preserve an existing managed source
installation, configuration and pairing state; a new clone is not a second
running service.

```sh
cd "$HOME/music-assistant-source-setup"
```

Continue with the installer below, then **device selection, pairing and
foreground playback**. Installing files alone does not make a new source
ready for use.

From that checkout, as your normal desktop user:

```sh
sudo bash scripts/install-source.sh
```

This installs the capture package in its own Python virtual environment with
a separate service account and state directory. It preserves existing source
configuration and pairing state. It does not pair with MA or enable capture
on a first installation. It installs `python3-venv`, `libportaudio2`,
`libasound2-plugins`, `libsndfile1`, `ca-certificates` and `util-linux` from APT and the
Python package's dependencies from PyPI; Internet access is needed for these
downloads. The source uses `aiosendspin` **9.1.1**, `sounddevice` **0.5.3** and
`soundfile` **0.13.1**. The installer verifies FLAC/WAV PCM16 codec support
before activating the release; recording remains off.

There is no `sudo pip install` into system Python and no dependency on your
interactive shell's Python environment. Capture credentials do not belong in
the display's `.env` or `/etc/sendspin-karaoke/environment`.

## 3. Select the UCA222 input explicitly

With the USB interface connected, enumerate inputs **as the capture service
user**, so device visibility reflects unattended operation:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source devices
```

The UCA222 can appear as **USB Audio CODEC**, not as "Behringer UCA222".
Select its capture input, not an HDMI output or the desktop's default audio
device. Use the exact card-ID selector reported by the command, for example
`hw:CARD=CODEC,DEV=0`; do not assume
that ALSA card 1 or a numeric device index remains the same after a reboot.
If several USB interfaces have indistinguishable names, resolve the ambiguity
before enabling capture. Identical interfaces can acquire different ALSA
card-ID suffixes depending on connection order; a card-ID selector is not a
USB serial-number binding.

Start the connected source and run this local, three-second input measurement,
replacing the example selector with yours:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source check-device \
  --device 'hw:CARD=CODEC,DEV=0'
```

It reports left/right levels, clipping and capture errors, then closes the
input. It does not connect to MA, open pairing state, save a recording, or
play audio locally. Both channels should show a signal during music; repeated
clipping calls for correcting the analogue level. Run it with the source
service stopped so the two processes do not compete for the input.

Edit the separate source configuration:

```sh
sudoedit /etc/sendspin-karaoke-source/environment
```

Set the following values, replacing both placeholders:

```ini
SOURCE_SERVER_URL=ws://YOUR_MA_HOST:8927/sendspin
SOURCE_DEVICE="EXACT_CAPTURE_DEVICE_SELECTOR"
SOURCE_NAME="UCA222 Line In"
```

`YOUR_MA_HOST` is the machine running Music Assistant, **not the Pi** unless
MA really runs there. Use MA's configured Sendspin port if it differs from
8927. This is not the MA web UI port, the HA web UI URL, an ingress URL, or
the display's port 8787. A DHCP reservation or reliable local DNS name helps.

This file uses systemd environment syntax, not shell code. Do not use `export`,
command substitutions, or `source` the file. The service uses stereo,
48 kHz, 16-bit capture. Configuring 24-bit capture does not add resolution to
the UCA222's converter.

## 4. Pair the source with Music Assistant

MA 2.10.2 includes the Sendspin Source plugin. **Pairing is mandatory for
the source role**, even if MA allows unpaired players. Do not disable pairing
or copy the display's MA access token into the source configuration.

Run pairing as the **same service user** and with the **same state directory**
that unattended capture will use:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source pair \
  --server-url ws://YOUR_MA_HOST:8927/sendspin \
  --name "UCA222 Line In" \
  --state-dir /var/lib/sendspin-karaoke-source
```

Keep this terminal open. In Music Assistant, locate the new Sendspin device
and complete its configuration/pairing request using the PIN printed by this
command. Wait for the command to report success. Do not post the PIN or pairing
state in an issue or chat.

Pairing from your desktop user's account with a different state directory
would create a different identity; it would not pair the system service.
Pairing itself does not start streaming your analogue input.

## 5. Try capture, then enable it at boot

After successful pairing, run the service in the foreground first, using the
same host, name and device you put in the environment file:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source run \
  --server-url ws://YOUR_MA_HOST:8927/sendspin \
  --device 'hw:CARD=CODEC,DEV=0' \
  --name "UCA222 Line In" \
  --state-dir /var/lib/sendspin-karaoke-source
```

Replace the example device selector with yours. These explicit flags are
necessary because a manual command does not load systemd's environment file.
For a repeat setup, stop the existing service before running this command.

In Music Assistant:

1. Select the **CAST**, player or group where you want to hear the input.
2. Open **Browse** and choose the source's Live Input. When there are several
   Sendspin inputs, open **Sendspin Source** and select **UCA222 Line In**.
3. Press **Play**, then start the connected CD player or turntable.

Without an explicit local recording request, the service waits for MA to
request the source before capturing and sending audio. Stop or deselect that
input in MA to end streaming; the device remains open if a local recording is
still active. Starting the system service is not itself a command to record
or switch your speakers away from their current music.

After hearing both channels on the intended player, stop the foreground
command with **Ctrl+C**, then enable unattended operation:

```sh
sudo systemctl enable --now sendspin-karaoke-source.service
sudo systemctl status sendspin-karaoke-source.service --no-pager
sudo journalctl -u sendspin-karaoke-source.service -n 60 --no-pager
```

Select the input in MA again if necessary. The service and foreground command
must not run concurrently with the same pairing state.

This source does not advertise automatic signal detection to MA. Dropping a
needle does not select the input, and the local recorder's silence stop does
not stop MA playback. Use the explicit MA playback controls for listening.

MA converts incoming audio to its Live Input format and buffers it for stable
playback. Increasing the Sendspin Source provider's **Target latency** may
help network instability but adds delay and applies to all Sendspin sources.
Start with defaults rather than chasing minimum latency.

### Dropouts with the initial source release

Source **0.1.1** fixes a timing defect in the initial implementation: Python
callback scheduling delays could become apparent gaps in otherwise continuous
ADC audio. The updated sender anchors its timestamps to the PortAudio clock
once per stream instead of moving the clock mapping on every callback.
The streaming log now includes **`stable ADC clock`**.

It also tolerates brief send stalls instead of reconnecting after 250 ms.
The queue remains bounded to 32 blocks (800 ms), samples older than one
second are rejected, and a one-second send stall still triggers reconnection.
These are maximum recovery budgets, not an added fixed playback delay.
STOP and disconnect continue to discard queued audio.

Use the [source update procedure](#operation-updates-and-recovery) below;
existing pairing and configuration remain valid. This does not establish that
all physical dropouts have the same cause. If problems remain, compare the
updated source journal with MA's Sendspin Source logs before changing latency
or blaming the UCA222. A transport timeout alone is not a reason to re-pair.

## Optional FLAC/WAV recording

Source **0.2.0** adds local recording controls. Recording is **off by default**
and never resumes automatically after a service restart. These commands run
in a terminal **on the display/capture Pi**, not in the MA Docker container,
TrueNAS shell or Home Assistant terminal. They control the already-running
source service through a private local socket, so do not stop the service
before using them. Complete the initial device configuration and pairing
first; these controls do not replace the source service's setup requirements.

Start a FLAC recording immediately:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source record-start --format flac
```

Or choose WAV for this recording:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source record-start --format wav
```

Choose one start command, not both. Only one recording is active at a time.
Each start creates a unique file; existing recordings are not overwritten.
No separate `arecord`, JACK or second USB capture process is needed.

Recording begins immediately, even when MA is not playing the line-in or is
temporarily unreachable. If the input stays silent from the start, recording
ends after five seconds: this is not a "wait for the needle" mode. Start your
source promptly or start recording once it is playing.

Both formats save the original **48 kHz, 16-bit, stereo PCM input**. FLAC is
lossless compression; WAV is uncompressed. Neither adds quality beyond the
UCA222 ADC, applies MA's player DSP/volume changes, recognizes tracks, tags
albums, or automatically splits a record into songs.

### Silence stop and manual controls

The recorder ends after **five continuous seconds of silence**, then stays
off until another explicit `record-start`. Silence is measured using the
highest absolute PCM sample across both channels in each 25 ms block. A
block at or below the threshold counts as silence; any above-threshold sample
on either channel resets the interval. The interval counts captured samples,
not wall-clock time; initial silence counts and is retained, as are the final
five seconds. A sufficiently quiet gap between songs can end the recording,
not just the end of a side.

The default threshold is **-45 dBFS**. To change it for one recording:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source record-start \
  --format flac --silence-dbfs -45
```

Vinyl surface noise is not digital silence. A less negative threshold
(for example, `-35`) treats more background noise as silence, but can cut off
quiet music. A more negative threshold (for example, `-55`) protects quieter
passages, but a noisy run-out groove may never become quiet enough to stop.
Qualify the threshold on your own source; it is not automatic end-of-record
recognition.

Inspect recording state or stop early:

```sh
sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source record-status

sudo -u sendspin-karaoke-source \
  /usr/local/bin/sendspin-karaoke-source record-stop
```

These commands use the normal `/var/lib/sendspin-karaoke-source` state
directory. If running a separately configured service, pass its matching
`--state-dir`; do not create another identity or run a second capture service.
There is no recording toggle in the display or Music Assistant UI.

### Listening and saving at the same time

The service opens the UCA222 once and shares captured blocks between the
local recorder and the live Sendspin connection. You can start or stop MA
playback while recording; MA STOP, reconnection and network send stalls do
not themselves stop the local recording. Likewise, ending a recording does
not stop MA playback. When neither needs audio, the capture device closes.

Disk/codec work is separate from the audio callback and live-send path.
Recording buffers are bounded: a disk or writer failure must surface as a
recording error, not an ever-growing queue or delayed audio sent to MA.
A USB/capture failure can affect both consumers because they share the
physical device. Do not unplug the UCA222 or restart/upgrade the service
during a recording. Fatal configuration or pairing errors still stop the
service and finalize/stop its recording; independence from normal network
outages does not bypass the service's authorization requirements.

### Files and storage

Files are saved on the **Pi**, not on the Music Assistant/TrueNAS host:

```text
/var/lib/sendspin-karaoke-source/recordings
```

The status command reports the recording's file and outcome. Active or
failed recordings have a `.partial` suffix; the completed `.flac` or `.wav`
name appears only after successful finalization. Do not treat a partial file
as a complete archive or remove its suffix to hide a recording failure.
Status is JSON, with `state`, `active` and `path`; once a recording has been
requested it also reports its format, threshold, frame count and stop reason
or error. `worker_pending` means the previous writer is still finishing and
another recording cannot start yet. The last outcome is retained in memory
until another recording or a service restart, not as a persistent history.

### Copy a completed recording

The directory is private to the service account. Run `record-status` as shown
above and wait for `state: "completed"` and `worker_pending: false`; the path
must end in `.flac` or `.wav`, not `.partial`. Inspect saved files with:

```sh
sudo -u sendspin-karaoke-source \
  ls -lh /var/lib/sendspin-karaoke-source/recordings
```

As your normal Pi desktop user, copy **one completed file** into a private
folder. Replace `COMPLETED_RECORDING.flac` with the exact completed filename
from the listing (use `.wav` for a WAV recording):

```sh
install -d -m 700 "$HOME/Recordings" &&
sudo install -o "$(id -un)" -g "$(id -gn)" -m 600 \
  "/var/lib/sendspin-karaoke-source/recordings/COMPLETED_RECORDING.flac" \
  "$HOME/Recordings/COMPLETED_RECORDING.flac"
```

Choose an unused destination filename; `install` replaces an existing
destination. The original stays in the service directory. You can now transfer
the private copy using your normal account, for example with SFTP over SSH.
Do not export `.partial` files as completed recordings, `chmod`/`chown` the
whole state directory, or share it through SMB: it also holds identity keys
and pairing credentials.

Uncompressed WAV uses about **691 MB per hour**; FLAC size depends on the
signal and surface noise. Leave free space for the Pi OS and display.
Each recording has a safety cap of **6 hours, 12 minutes, 49.6 seconds**
(1,073,740,800 stereo frames) in either format, keeping WAV below its classic
4 GiB size boundary. Reaching it finalizes the file with reason `size-limit`
and leaves recording off; the service does not silently start another file.
Recordings are not automatically uploaded to MA, copied to a NAS, deleted,
or rotated. Export individual completed files using an administrator account,
and retain only the copies you need. Do not make the whole source state
directory into an SMB share or loosen its permissions: it also holds pairing
credentials.

Use the source-only update procedure below before these commands on an
older installation. The upgrade preserves configuration and pairings, but
its service restart interrupts playback and any recording.

## What happens to the display

The display still follows its configured CAST/player; the capture service
does not change that configuration or create an extra audio output on the Pi.
Select **Ambient** for records or CDs.

Analogue input contains audio, not a track URI, cover or lyrics. This service
does not perform song recognition or synthesize now-playing metadata. A source
name in MA is not enough to retrieve the correct song's synchronized lyrics.
Do not repoint `MA_PLAYER_ID` at the capture-only source to make lyrics appear.

## Operation, updates and recovery

To stop capture and prevent it starting at boot without affecting the display:

```sh
sudo systemctl disable --now sendspin-karaoke-source.service
```

After changing the source configuration:

```sh
sudo systemctl restart sendspin-karaoke-source.service
```

For an update, obtain the intended trusted version of this checkout and rerun
`sudo bash scripts/install-source.sh`. The installer does not restart an
already running source; explicitly restart it afterwards to use the new
release. The normal display upgrade and uninstall scripts manage only the
display, not the optional source.

For the separate checkout created above, first run
`cd "$HOME/music-assistant-source-setup"` and inspect `git status --short`.
If it lists changes, preserve them and resolve them before updating; do not
reset or clean them away. Confirm `git remote get-url origin` identifies
`JamesDun2866/music-assistant-display` and `git branch --show-current` reports
`main`. With that clean public checkout:

```sh
cd "$HOME/music-assistant-source-setup" &&
git fetch origin main &&
git merge --ff-only FETCH_HEAD &&
sudo bash scripts/install-source.sh &&
sudo systemctl restart sendspin-karaoke-source.service
```

Run this update block only after the first setup and pairing are complete.
It updates the separate public source checkout without switching or updating
the display checkout. For a source originally installed from an unrelated
repository, first create the new public clone described above, then run its
installer and explicitly restart the existing source service; no new pairing
is normally needed. Never try to fast-forward between unrelated repositories.
If a public update refuses a divergent history,
stop rather than force-resetting. A failed fetch, merge or install prevents
the restart. Successful updates preserve the source's configuration, identity
and pairings; no new pairing is normally needed. The restart briefly
interrupts line-in audio, so schedule it between listening sessions.

```sh
sudo systemctl status sendspin-karaoke-source.service --no-pager
sudo journalctl -u sendspin-karaoke-source.service -n 60 --no-pager
```

| Location | Purpose |
| --- | --- |
| `/opt/sendspin-karaoke-source/releases/` | Root-owned package and virtual-environment releases; retained during updates |
| `/opt/sendspin-karaoke-source/current` | Active release symlink |
| `/usr/local/bin/sendspin-karaoke-source` | CLI wrapper for the active release |
| `/etc/sendspin-karaoke-source/environment` | Protected source-only configuration |
| `/var/lib/sendspin-karaoke-source` | Service-owned private identity, pairing, single-process lock and local recording control |
| `/var/lib/sendspin-karaoke-source/recordings` | Private local recordings and explicitly marked incomplete files |
| `/etc/systemd/system/sendspin-karaoke-source.service` | Opt-in boot service |

There is no source uninstaller in this version. Disabling its service stops
capture without removing the private pairing state or touching the display.

Back up `/etc/sendspin-karaoke-source` and
`/var/lib/sendspin-karaoke-source` only to private storage. The latter contains
the source's cryptographic identity and pairing credentials. Preserve
ownership and restrictive permissions when restoring; do not clone one
identity onto two simultaneously running source devices.

For pairing recovery, stop the service before running the pairing command.
Do not delete pairing files just because Wi-Fi or MA is temporarily unavailable.
If trust was intentionally revoked in MA, complete a new pairing explicitly.

| Symptom | Action |
| --- | --- |
| No USB input listed | Check the USB cable/port, power and OS device detection; the name may be USB Audio CODEC. Confirm the command ran as the service user. |
| Ambiguous or missing configured device | Run `devices` again and correct the exact selector. Do not switch to a default device as a workaround. |
| Device busy | Close other recording applications using that input. Use the source's own recording controls for simultaneous listening and recording. Inspect per-device desktop audio use; do not disable PipeWire globally or alter the kiosk. |
| Cannot connect to MA | Check the MA host and Sendspin port, Wi-Fi, firewall and VLAN/client isolation. A working MA web page does not prove that port 8927 is reachable. |
| Connected but no Live Input | Complete pairing and confirm the source service is running. Allowing unpaired playback is not sufficient. |
| Playing but silent | Confirm RCA INPUT wiring and a running line-level source. Check source levels and the chosen playback target. A stopped turntable does not cause an error. |
| Distortion | Check input clipping before increasing network buffers. Lower a variable source output if necessary; software attenuation cannot recover already clipped input. |
| Echo | Stop the parallel direct-monitor/direct-amplifier route, or stop the network route. |
| Dropouts | Inspect source and MA logs, MA host/container memory pressure, Pi power/thermal throttling and Wi-Fi reliability. Low CPU does not rule out memory pressure. A buffer change cannot repair a failing USB connection. See the optional [MA host migration guide](music-assistant-migration.md) if host resources are the problem. |
| Service exits with status 2 | Correct configuration, device selection, private state permissions or pairing as indicated in its log, then explicitly restart it. |
| Service exits with status 3 | An unexpected internal error stopped the service without retrying. Retain the sanitized error class/context for diagnosis; do not delete pairing state. |
| No lyrics or album art | Expected for unrecognized analogue audio; use Ambient. |
| Recording command cannot reach the service | Start the source service and run the command as its service user with the same state directory. Do not start a second capture process or change socket permissions. |
| Recording stops before the music starts | Recording starts immediately and initial silence counts. Start the analogue source promptly; recording does not arm and wait for sound. |
| Recording stops between songs | Five seconds of below-threshold audio ends the file permanently. Adjust the threshold if quiet music is misclassified, or explicitly start another recording. |
| Recording never stops in the run-out groove | Surface noise may exceed the silence threshold. Stop manually or use a less negative threshold on a later recording, checking that it does not cut off quiet music. |
| Recording error or `.partial` file | Check the recording status and journal, free disk space and USB/device condition. Preserve the partial file if needed, but do not assume it contains all captured audio. |

Before relying on unattended operation, exercise both channels, MA stop/start,
USB unplug/replug, an MA restart, a Wi-Fi interruption, and a normal Pi reboot
while the display is running. Recovered playback must contain current audio,
not a replay of audio accumulated during the outage. Do not assume simulated
protocol coverage establishes behavior on physical hardware.

## References

- [MA 2.10.2 Sendspin Source behavior](https://github.com/music-assistant/server/blob/2.10.2/music_assistant/providers/sendspin_source/README.md)
- [MA Sendspin Source user guide](https://www.music-assistant.io/plugins/sendspin-source/)
- [Sendspin source role](https://github.com/Sendspin/spec/blob/main/roles/source/v1.md)
- [aiosendspin protocol library](https://github.com/Sendspin/aiosendspin)

The normal `sendspin daemon` is an audio **player**, not this capture service.
The older JACK bridge's experimental instructions are not the installation
path for this implementation.
