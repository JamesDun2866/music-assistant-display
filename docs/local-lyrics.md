# Local synchronized lyrics through Music Assistant

The Pi bridge has **no lyrics upload endpoint or watched LRC directory**.
Supply lyrics to Music Assistant's local music provider; the bridge retrieves
the actual queued track and its lyrics through MA. This is not a way to attach
a random local file to a different streaming-provider track with the same title.

Use lyrics you created or are authorized to use. The examples below are synthetic,
not lyrics from a commercial song.

## Add an LRC beside your own audio file

1. Locate the audio file in the music storage **visible to MA's local provider**.
   If MA is containerized, use the underlying music share/bind mount, not the Pi
   renderer's filesystem.
2. Save a UTF-8 `.lrc` file with the **same basename** beside the audio. For
   example, `Practice Track.flac` and `Practice Track.lrc`, not
   `Practice Track.flac.lrc`. Match filename case on case-sensitive storage.
3. Give the MA provider permission to read it, using the share's existing
   ownership/security policy rather than world-writable permissions.
4. In MA, refresh the actual local track and allow its provider/library scan to
   complete. MA's current guidance calls this **Refresh Item**. For changes only
   to an existing sidecar, use Refresh Item or update the audio file's modification
   time so a subsequent scan notices it; merely editing the sidecar may not
   trigger the audio scanner.
5. Confirm the correct lyrics appear for that local track in **MA first**, then
   play that same local-library/provider item on the configured CAST queue.

A minimal original practice file could contain:

```text
[00:00.00]The practice screen is ready
[00:04.00]A second line arrives
[00:08.50]Now the final cue
```

Timestamps are positions from the **start of that recording**, in
`[minutes:seconds.fraction]` form. These example times are arbitrary; author
real cue times against your own recording. LRC provides line-level timing,
not per-word highlighting. Plain text without timestamps remains unsynchronized.
For a constant TV/audio delay, prefer the Pi's saved visual offset rather than
rewriting the song's timing for one room.

## Embedded lyrics, corrections and cache delays

MA's documented precedence starts with **embedded audio-file lyrics**, then a
same-basename LRC, then provider/metadata-provider sources. If an old embedded
tag wins over your sidecar, back up your audio and correct that tag using your
usual tag editor; do not assume another LRC overrides it. MA's ordinary
**Update Metadata** does not necessarily replace already populated lyrics.
Use its documented Refresh Item/local-file procedure instead. Menus and scan
behavior depend on the installed MA/provider version.

The bridge reads stored lyrics with `MA_ALLOW_LYRICS_REFRESH=false`; enabling
that flag is not required simply to display lyrics already present on the Track.
An empty library Track may remain blocked until MA itself has ingested the file.
The flag's separate enrichment/write implications are explained in
[MA integration](music-assistant.md#read-only-and-enrichment-policy).

The bridge also has a bounded persistent lyrics cache: existing timed/plain
results can last **one day**, missing results **five minutes**. A browser reload
or backend restart alone does not clear that cache. After MA shows your corrected
lyrics, allow the cache to expire and reselect the track in MA so the bridge
loads it again. Avoid repeated refreshes against public lyrics providers.

If you need an immediate local-authoring recheck, the following **optional Pi
administrator procedure** retains the old cache as a private backup instead of
deleting it. It briefly interrupts visuals, not CAST audio. First confirm the
standard native state path and an existing `lyrics-cache` directory:

```sh
sudo ls -ld /var/lib/sendspin-karaoke/lyrics-cache
sudo systemctl stop sendspin-karaoke.service
sudo mv /var/lib/sendspin-karaoke/lyrics-cache \
  "/var/lib/sendspin-karaoke/lyrics-cache.before-edit-$(date -u +%Y%m%dT%H%M%S)"
sudo systemctl start sendspin-karaoke.service
```

Stop if the initial path check fails. If moving the cache fails after stopping
the service, inspect the error and restart the service; do not remove the whole
state directory. The service recreates only its active cache. Your saved view
and offset in `settings.json` are untouched. Retained cache backups may contain
private metadata/lyrics and use disk space: remove only those specific backups
when no longer needed. This clears the Pi's cache, **not MA's metadata**, and is
not necessary for ordinary playback.

Source: [Music Assistant's official lyrics guide](https://www.music-assistant.io/metadata/lyrics/),
including local-file precedence and its "wrong lyrics" refresh instructions.
Return to the [full installation walkthrough](installation-guide.md#6-connect-your-real-music-assistant-queue).
