# Optional: move Music Assistant from the HA app to Docker/Dockge

This advanced guide moves an existing **Music Assistant 2.10.2** Home
Assistant app (formerly add-on) to a standalone Linux Docker host, including
TrueNAS with Dockge. It is **not required** for the display, UCA222 source or
recorder. The UCA222 stays connected to the Pi; only the MA server moves.

MA host/container memory pressure is one possible cause of source stalls,
even when CPU usage is low. Compare MA/source logs, memory limits, available
RAM, swap and any out-of-memory events before concluding the USB hardware is
faulty or a migration will fix it. Network, power and capture faults have
different causes. Moving hosts is not a substitute for diagnosis.

Keep the same **2.10.2** release for the move, not `latest`, beta or a combined
upgrade/migration. Keep the original app data and private backup until the new
installation is accepted. Never run two servers from copies of the same MA
identity at the same time.

## 1. Establish a standalone login before taking the backup

**Do this first while the old HA ingress interface still works.** In Music
Assistant, open **Settings > Profile** and establish a local MA username and
password. An HA ingress/HA-auth-only session is not proof that you can log in
to a standalone MA server.

Open `http://OLD_MA_HOST:8095` directly in a private browser window and test
that username/password without ingress. If the app's direct web port is not
available, enable its supported direct access setting first. Do not proceed
until direct MA login succeeds. Save the credentials privately; do not put
them in Compose, Git, a URL, screenshots or support logs.

## 2. Back up and extract MA's complete data

1. Stop playback and stop the old MA app. Keep any destination MA container
   stopped too. Prevent automatic restarts during the transfer; check that
   the app remains stopped after backup operations.
2. Create a fresh Home Assistant backup **including Music Assistant** after
   setting the local login. Download a **decrypted export** through Home
   Assistant's supported backup interface; retain any recovery key privately.
   Keep the original backup unchanged.
3. Inspect the archive in private staging storage. The MA app backup is
   normally the nested `d5369777_music_assistant.tar.gz`; it contains the
   app's `data` directory. Names/layouts can vary: inspect the archive instead
   of assuming that the outer HA archive is the MA data volume.
4. Extract and transfer **all contents** of that MA `data` directory, including
   hidden files, while both instances are stopped. Preserve `auth.db`,
   `settings.json`, `library.db`, any database sidecars and the Sendspin
   identity/key/pairing files, not just the music library database. Do not
   rebuild selected settings by hand or generate a fresh identity.

Backups contain tokens, account details and cryptographic keys. Do not commit,
publish or place them on a broadly accessible SMB share. Use a trusted archive
tool and private staging directory; do not extract uninspected archives over
live NAS datasets or application data.

## 3. Prepare the destination and Compose

Create a dedicated, persistent MA data directory using your host's supported
administration tools. On TrueNAS use an **absolute dataset path**, for example
`/mnt/POOL/DATASET/music-assistant/data`; replace `POOL` and `DATASET` with
your own existing storage layout. Do not use a relative `./data` path or a
path inside the Dockge container: those can point somewhere other than the
intended NAS dataset.

Copy the extracted directory's **contents** into that destination, so
`auth.db`, `settings.json` and `library.db` sit directly in the directory
mounted as `/data`, **not `/data/data`**. Preserve the complete directory and
appropriate private permissions; confirm the MA container can read and write
it before starting.

Docker-created files may be root-owned and inaccessible to SMB users. Prefer
a stopped, administrator-controlled transfer. If ownership needs adjustment,
scope it to this dedicated MA data directory and the actual container account,
using the NAS's supported ACL/ownership tools. Do not use `chmod 777`, change
the whole pool's ownership, or make all NAS data writable to solve one copy
failure. Do not delete a pre-existing destination: back it up separately and
resolve which data copy is authoritative.

Use this minimal Compose in Dockge or Docker Compose after replacing the
absolute host path:

```yaml
services:
  music-assistant:
    image: ghcr.io/music-assistant/server:2.10.2
    network_mode: host
    restart: unless-stopped
    volumes:
      - /mnt/POOL/DATASET/music-assistant/data:/data
```

Do not start it until the stopped transfer is complete. No `privileged`,
extra capabilities, USB passthrough or Docker socket mount is needed for
this network-source setup. If a library uses local files, separately mount
the host's music directory read-only at the path expected by that provider.
An old HA `/share` or `/media` path does not automatically exist on the new
host. Prefer host-mounted music shares and read-only container bind mounts
over granting MA broad privileges to mount SMB/NFS itself.

Host networking is for Linux and shares the host's ports; do not add Compose
`ports` mappings here. MA and its network players should be on the same LAN/
layer-2 network with working multicast discovery. The default web interface
is TCP **8095**, the player stream server TCP **8097** (check MA's actual
configured/listening port), and Sendspin TCP **8927** at `/sendspin`.
Other player protocols can require additional ports; these three ports are
not a complete firewall allowlist. Do not expose MA or these ports publicly.

## 4. Resolve an mDNS port conflict only if one occurs

If startup reports **UDP 5353 address already in use**, inspect rather than
killing processes. On the Docker host, this read-only command identifies
listeners when the host provides `ss`:

```sh
sudo ss -ulpn 'sport = :5353'
```

Check whether Avahi or another mDNS service owns the conflicting socket and
whether a second MA instance is running. Do not kill random processes or edit
TrueNAS-generated configuration files.

On TrueNAS versions with a supported **mDNS service announcement** toggle
in network settings, disabling that announcement is an optional remedy for
a confirmed Avahi conflict, not a mandatory migration step. **It can remove
the NAS's `.local`/Bonjour discovery**, including SMB advertisements; SMB
access by the NAS IP can still work. Record the old setting and the NAS IP
before changing it. Leave ordinary DNS servers, gateway and WS-Discovery
settings unchanged. Use the supported UI for your TrueNAS version; if the
setting is unavailable or the owner is different, investigate that service
instead of applying an unrelated workaround.

## 5. Start once, then reconnect the Pi and Home Assistant

Start the destination stack and open `http://NEW_MA_HOST:8095`. Sign in with
the local MA credentials established before backup. Check the library,
providers, players and Sendspin Source configuration before editing clients.
If you see a fresh setup or cannot log in, stop the destination and check the
data mount, nested directory and backup/login preparation. Do not erase the
auth database or pairing keys as a shortcut.

On the **Pi**, preserve its source configuration and state; change only the
MA host address in the existing environment file:

```sh
sudoedit /etc/sendspin-karaoke-source/environment
```

```ini
SOURCE_SERVER_URL=ws://NEW_MA_HOST:8927/sendspin
```

Use the actual configured Sendspin port if different. Between listening/
recording sessions, explicitly restart the source:

```sh
sudo systemctl restart sendspin-karaoke-source.service
```

Copying MA's identity and pairings should preserve trust; no source identity
reset or new pairing is normally required. If trust fails, first confirm that
the complete MA data was restored and the Pi is reaching the intended server.
The [source installer/update procedure](uca222-source.md#operation-updates-and-recovery)
preserves this URL, other configuration and private state, and never
automatically starts or restarts the service.

For the display, change `MA_URL` in `/etc/sendspin-karaoke/environment` to
`http://NEW_MA_HOST:8095` and explicitly restart `sendspin-karaoke.service`.
Keep its token and player/queue IDs when the restored MA server retains
them; check [MA setup](music-assistant.md) if authentication or routing fails.
Do not point the display at the source-only device instead of its player.

Update Home Assistant's Music Assistant integration to the new MA address
using its supported reconfiguration flow. Review MA's Home Assistant provider
connection too: HA-app-only internal addresses or ingress authentication may
need the reachable HA URL and explicit reauthentication. Other providers or
local library paths may also need reconnection on the new host; a database
copy does not guarantee every external credential remains usable.

## 6. Accept or roll back without losing the original

Confirm direct local login, library/provider access, ordinary playback and
multiroom line-in. Check that the display still follows its intended player.
If using the [optional recorder](uca222-source.md#optional-flacwav-recording),
check an explicitly started recording and its completed file on the Pi; it
does not move to Docker or start automatically.

After acceptance, leave the old HA MA app **stopped** and disable its
**start-on-boot/autostart and watchdog** settings. Keep its data, the original
backup and relevant NAS snapshots until satisfied with recovery and normal
operation. Upgrade MA separately later, with a new backup.

For rollback, stop the new container and prevent its restart **before**
starting the old app. Point Pi and HA clients back to the old host. Do not
run both identities simultaneously or copy a live destination database over
the old data. Changes made after migration may not exist in the old copy.

See also the upstream [MA installation/network requirements](https://www.music-assistant.io/installation/)
and [Home Assistant backup documentation](https://www.home-assistant.io/common-tasks/general/#backups).
