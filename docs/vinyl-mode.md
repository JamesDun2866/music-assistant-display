# Vinyl mode

Select **Vinyl** in the display's existing view tabs, using a pointer, keyboard,
or TV remote. Keyboard shortcut **5** selects it when focus is not in a control
or reading pane. The choice is saved on the local display service for all
displays and survives a service restart. Audio activity, identification results,
and Music Assistant updates never automatically select Vinyl.

The existing Now Playing, Lyrics, Split and Ambient choices are unchanged.
**Line-in album** remains an independent, temporary view; selecting it does not
overwrite the saved view.

## Quiet, independent album display

Vinyl shows the **last identified album**, not the selected Music Assistant
player's current song. It has no song progress, track highlighting, lyrics,
spinning record, decorative background downloads or playback controls. It uses the same
local cached album and shared polling/expiry logic as Line-in album.

The source's persistent album cache survives silence, failed identification,
disabled recognition, an offline source and reboots. Live recognition status
expires independently: an unreachable source is labelled unavailable while
known artwork and album information remain. Before the local service has
provided an album, Vinyl shows a neutral placeholder rather than inventing one.
If the display service itself cannot be reached after a browser reload, its
saved view and cache cannot be loaded until reconnection.

Art is displayed with `object-fit: contain`, preserving the decoded image
ratio without cropping or stretching. [Full-cover artwork](album-artwork.md)
retains up to 1200 x 1200 pixels. Legacy thumbnail images remain visible until
a successful cache upgrade; existing letterboxing is preserved rather than
guessing which pixels to crop. Displaying a small source at a larger size does
not add missing detail.
Long metadata remains readable in a scrollable album pane.

**Show tracklist** reveals the complete supplied catalog tracklist, including
every disc and up to the API's 200-track limit. It never guesses the track
currently playing. The tracklist has its own scrolling pane; focus it and use
Up/Down to scroll, Left/Right to leave. On narrow mobile screens the cover and
tracklist stack vertically.

## Controls, meters and recognition

The cover-first defaults are **tracklist hidden, stereo meters visible**.
Both toggles save immediately. Meter values come from the shared passive
source telemetry store, not browser audio capture. Hiding meters unsubscribes
this view. When shown, meters retain their active/inactive/stale/unavailable
status and possible-clipping labels even while the controls are hidden.
Values are not live-region announcements; inspecting them with a screen reader
does not continuously announce the 15 Hz samples. RMS, peak and hold are
approximate input measurements, not calibrated VU or true peak.

Controls fade after eight seconds without interaction. Pointer movement,
touch or a key reveals them. The first TV/keyboard navigation key only wakes
hidden controls; it does not select or run an action. Focused controls, forms,
open details and dialogs keep controls visible. Escape/Back closes the
innermost dialog or details panel and restores focus. **Hide controls** moves
focus to the scene before hiding; it will not hide an open panel. Reduced
motion disables the fade. There is no perpetual visual animation.

**Line-in details** contains the recognition explanation and explicit
**Retry identification** command. Retry uses the existing local CSRF-protected,
source/boot/generation-bound command. It is unavailable during sampling,
recognizing, inactive/disabled/offline states or a pending request. It never
enables recognition or starts playback/recording. The normal Display settings,
fullscreen and shared Tools entry point remain in the common application
chrome; Vinyl does not create a second tools shell.

## Settings compatibility

`settings.json`, `/api/settings`, and browser snapshots support:

```json
{
  "viewMode": "vinyl",
  "vinyl": { "showTracklist": false, "showMeters": true }
}
```

Old settings without `vinyl` gain these defaults in memory and on the next
save. Loading valid old settings does not change the selected view or rewrite
the file solely for this addition. Visual offset, lyric-follow mode, Ambient
slideshow, dwell time, empty selections and uploaded-image selections are
preserved. Concurrent partial updates are merged inside the existing serialized,
atomic SettingsStore writes. Vinyl booleans are strictly validated; strings
such as `"false"` are not coerced.

## Correction integration

`VinylView` renders the effective `view.album` and `view.tracklist` from the
shared `useLineInAlbum()` hook. Its optional
`renderCorrection(view, refresh)` prop is the integration point for the
reusable correction editor, inside Line-in details.
The application supplies the same `AlbumEditionCorrection` editor used by
Line-in album. Open **Line-in details > Correct album edition** to search,
preview and confirm; corrected data is labelled **Corrected catalog edition**
beside the cover. A current-identification-only correction is identified in
the details. Corrections describe catalog editions, never a verified physical
pressing, and do not rewrite the journal's original recognition events.

## Hardware-free coverage

The existing Vitest runner covers saved settings/migration, effective album
presentation, cache/failure states, 200-track navigation, CSRF retry, idle
focus protection and Escape handling. Build first, then run:

```powershell
node tests\vinyl-browser.mjs <artifact-directory>
```

The installed-Chrome fixture uses local synthetic album art and telemetry,
checks 1280 x 720, 1920 x 1080, 3840 x 2160, 390 x 844 and 320 x 568 layouts,
and writes screenshots and a JSON report. It does not contact Shazam, exercise
live audio, or qualify Raspberry Pi performance.
