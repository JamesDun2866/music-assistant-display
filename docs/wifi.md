# Wi-Fi provisioning and recovery

Raspberry Pi OS Trixie uses **NetworkManager**. Configure your Wi-Fi country,
SSID and credential in Raspberry Pi Imager before first boot, or use the desktop
network menu after boot. Do not follow legacy instructions that edit
`/etc/wpa_supplicant/wpa_supplicant.conf` as the primary network configuration.
The app installer never writes Wi-Fi credentials, changes network profiles,
enables an access point, forces autologin, or reboots the Pi.

Use a network that permits the Pi to reach your Music Assistant server. Guest/client
isolation, captive portals, an incorrect Wi-Fi country, or 5-GHz channel restrictions
can prevent connectivity even when a network is visible. A reservation in your
router can make administration more predictable. A fixed MA server address or
reliable local DNS name is preferable to an address that changes unexpectedly.

The bridge connects directly to the configured MA URL; it does not discover or
pair a new Sendspin device. A `.local` name typically depends on multicast DNS
(UDP 5353), which may not cross Wi-Fi/VLAN boundaries. Use router DNS or a reserved
MA address if multicast is unavailable. MA-to-CAST Sendspin discovery/pairing is
separate: follow MA's Sendspin setup and firewall guidance on that segment. Do
not assume permitting the bridge's WebSocket also permits multicast discovery
or CAST audio traffic. No bridge pairing or group changes are needed.

Test signal quality with the Pi in its final location behind/near the TV.
Prefer the band with stable reception, not simply the highest advertised speed;
poor 5-GHz coverage can be worse than a reliable 2.4-GHz connection. Avoid guest
isolation and captive-portal networks. No Ethernet connection is required.

## Inspect without printing credentials

Use a keyboard/local HDMI desktop or an already working SSH connection:

```sh
nmcli device status
nmcli connection show
nmcli device wifi list
ip route
```

Network interface names and connection profile names vary: substitute the names
reported above rather than assuming `wlan0`. Do not use `--show-secrets`, put a Wi-Fi
password on the command line, or paste full connection/configuration dumps into an
issue.

For an interactive credential prompt rather than a password in shell history:

```sh
sudo nmcli --ask device wifi connect "Your SSID"
```

Alternatively use `sudo nmtui` if installed, or the desktop Wi-Fi menu. To reactivate
a known saved profile without entering its password again:

```sh
sudo nmcli connection up "Your saved profile"
```

Changing the connection you are using for SSH can immediately disconnect you.
Plan a local keyboard/HDMI recovery path first. Do not remotely delete
the only working profile. Keep a recovery network profile where appropriate and
secure access to the Pi; saved NetworkManager secrets are managed by the OS, not
the app.

## What happens during an outage

The backend binds `127.0.0.1:8787` and starts independently of Wi-Fi; it does not
depend on `network-online.target`, DNS success, or MA availability. The Chromium
launcher waits only for this **local** HTTP endpoint. Built JavaScript/CSS/local
assets are served locally with no CDN dependency. Thus an already installed kiosk
can show its shell and connection status before the network connects.

Live metadata/lyrics/artwork still need MA and any relevant providers. A Wi-Fi
outage is not a request to wake, switch, or power down the TV. The app reconnects
its MA connection when networking returns. An explicitly enabled native CEC
listener can reconnect independently after transient HDMI loss, but never replays
power/input requests. CEC stays disabled by default.
Do not add an internet "ping before startup" loop to the backend or kiosk.

If the display is blank, check the local backend first:

```sh
curl --noproxy '*' --fail http://127.0.0.1:8787/ >/dev/null
systemctl is-active sendspin-karaoke.service
sudo journalctl -u sendspin-karaoke.service -n 50 --no-pager
```

If the local page works but live playback does not, check the Wi-Fi profile,
router/AP isolation, MA server reachability, and MA configuration. Re-enter the MA
token with `sudoedit /etc/sendspin-karaoke/environment`; do not include it in a
curl argument or screenshot. If the service runs but no browser appears, confirm
desktop autologin, a labwc session, and the desktop user's managed autostart block.

Full queue snapshots assume aligned Pi/MA system clocks. Keep network time
synchronization enabled on both hosts and inspect the Pi without changing it:

```sh
timedatectl status
timedatectl show -p NTPSynchronized --value
curl --noproxy '*' http://127.0.0.1:8787/readyz
```

If NTP has not synchronized after a networkless boot, grossly stale/future MA
queue timestamps are rejected. Once clocks and connectivity recover, periodic
queue reconciliation reanchors automatically. A manual lyric offset cannot fix
incorrect system time or highly variable Wi-Fi latency.

## Acceptance checks on the target Pi

1. Boot with Wi-Fi unavailable: the backend and local kiosk must load without
   waiting for a network-online service.
2. Restore Wi-Fi and MA: confirm playback/lyrics resume updating without reboot.
3. Switch to an incorrect/unavailable SSID with local recovery available, then
   restore the saved profile.
4. Restart the backend: confirm the browser reconnects and persistent settings
   remain.
5. Confirm none of these steps wakes, switches, or turns off the TV through CEC.

See Raspberry Pi's [official networking documentation](https://www.raspberrypi.com/documentation/computers/configuration.html#networking)
and [native deployment](deployment.md) for OS and application responsibilities.
