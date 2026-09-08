import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CecCommand, LyricFollowMode, TimedLine, ViewMode } from "../shared/protocol.js";
import { activeLineIndex } from "./clock.js";
import { localArtworkUrl } from "./schema.js";
import { usePlayback, type PlaybackView } from "./usePlayback.js";
import { useLocalCommand } from "./useLocalCommand.js";
import { AmbientLibraryControls, AmbientScene, useAmbientLibrary, useAmbientControls } from "./Ambient.js";
import { BUILTIN_BACKGROUNDS, DEFAULT_AMBIENT } from "../shared/ambient.js";
import { focusNavigation, keyboardNavigationKey, navigate } from "./navigation.js";
import { isExplicitKiosk, useRemoteNavigation } from "./useRemoteNavigation.js";
import type { NavigationAction } from "./remoteEvents.js";
import { CecDiagnostics } from "./CecDiagnostics.js";
import { KioskDiagnosticsPanel, useKioskDiagnostics } from "./KioskDiagnostics.js";
import { LineInAlbumView } from "./LineInAlbum.js";
import { VinylView } from "./VinylView.js";
import { DEFAULT_VINYL } from "../shared/vinyl.js";
import { ToolsPanel } from "./ToolsPanel.js";
import { ListeningJournal } from "./ListeningJournal.js";
import { AlbumEditionCorrection } from "./AlbumEditionCorrection.js";

function timeLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const TimedLyrics = memo(function TimedLyrics({ lines, active, trackId, followMode }: {
  lines: TimedLine[]; active: number; trackId: string; followMode: LyricFollowMode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLParagraphElement>(null);
  const [reading, setReading] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const instant = followMode === "instant" || reducedMotion;
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const changed = () => setReducedMotion(query.matches);
    changed();
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
  useLayoutEffect(() => {
    // Stop an in-flight native smooth scroll before handing the pane to the reader.
    if (reading && viewport.current) {
      viewport.current.scrollTo?.({ top: viewport.current.scrollTop, behavior: "instant" });
    }
  }, [reading]);
  useLayoutEffect(() => {
    const container = viewport.current;
    const line = selected.current;
    if (!container || !line || reading) return;
    let lastTarget: number | undefined;
    const follow = () => {
      const lineRect = line.getBoundingClientRect();
      const viewportRect = container.getBoundingClientRect();
      // Use a common coordinate system, including while smooth scrolling.
      const top = container.scrollTop + lineRect.top - viewportRect.top
        - container.clientHeight / 2 + lineRect.height / 2;
      if (lastTarget !== undefined && Math.abs(top - lastTarget) < 1) return;
      lastTarget = top;
      container.scrollTo?.({ top, behavior: instant ? "instant" : "smooth" });
    };
    follow();
    // Heartbeats no longer accidentally recenter after wrapping or a resize.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(container);
    if (container.firstElementChild) observer?.observe(container.firstElementChild);
    window.addEventListener("resize", follow);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", follow);
    };
  }, [active, trackId, lines, instant, reading]);

  return (
    <>
      <div className={`timed-viewport${instant ? " instant-follow" : ""}${reading ? " reading-lyrics" : ""}`} ref={viewport}
        aria-label="Timed lyrics" aria-describedby="lyric-reading-help" tabIndex={0} data-navigation-scroll
        onFocus={() => setReading(true)} onWheel={() => setReading(true)}
        onPointerDown={() => setReading(true)} onTouchStart={() => setReading(true)}>
        <div className="timed-lines">
          {active < 0 && <p className="intro-note">Listen for your cue…</p>}
          {lines.map((line, index) => (
            <p
              key={`${index}:${line.timeMs}`}
              ref={index === Math.max(0, active) ? selected : undefined}
              className={`lyric-line ${index === active ? "is-current" : ""} ${index < active ? "is-past" : ""}`}
              aria-current={index === active ? "true" : undefined}
            >
              {line.text.trim() ? line.text : <span aria-label="Instrumental break">♪</span>}
            </p>
          ))}
        </div>
      </div>
      <div className="lyric-follow-controls">
        <span id="lyric-reading-help">{reading ? "Follow paused for reading." : "Focus or scroll the lyrics to read freely."}</span>
        <button onClick={() => setReading(!reading)}>{reading ? "Resume lyric follow" : "Pause lyric follow"}</button>
      </div>
    </>
  );
});

function EmptyStage({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="empty-stage"><div className="stage-mark" aria-hidden="true">♪</div>
    <h2>{title}</h2><p>{children}</p></div>;
}

export function LyricsStage({ snapshot, displayPositionMs, cleared, stale }: Pick<
  PlaybackView, "snapshot" | "displayPositionMs" | "cleared" | "stale"
>) {
  if (cleared) return <EmptyStage title="Waiting to reconnect">The previous song has been cleared. This display will recover automatically.</EmptyStage>;
  if (!snapshot) return <EmptyStage title={stale ? "Local service unavailable" : "Connecting to the room"}>
    {stale ? "Check that the local display service is running. We’ll keep trying." : "Your lyrics will appear here when the local service connects."}
  </EmptyStage>;
  if (!snapshot.track || snapshot.playback === "idle") return <EmptyStage title="Ready when you are">
    {snapshot.demo ? "Press Play demo to try the display. No speakers or Music Assistant playback are controlled." : "Play a song on your configured Music Assistant player. This screen follows along."}
  </EmptyStage>;
  const { lyrics } = snapshot;
  if (lyrics.status === "timed" && lyrics.lines.length > 0) return (
    <TimedLyrics key={`${snapshot.generation}:${snapshot.track.identity}`}
      lines={lyrics.lines} active={activeLineIndex(lyrics.lines, displayPositionMs)}
      trackId={snapshot.track.identity} followMode={snapshot.lyricFollowMode} />
  );
  if (lyrics.status === "plain" && lyrics.plain) return <div key={snapshot.track.identity} className="plain-lyrics" tabIndex={0} data-navigation-scroll aria-label="Unsynced lyrics">
    <p className="plain-explanation">These lyrics have no timestamps. Scroll to read along.</p>
    <div className="plain-text">{lyrics.plain}</div>
  </div>;
  if (lyrics.status === "loading") return <EmptyStage title="Finding the words">
    Lyrics are loading. Playback continues on your player.
  </EmptyStage>;
  if (lyrics.status === "error") return <EmptyStage title="Lyrics couldn’t load">
    {lyrics.message || "The lyrics source returned an error. Playback is unaffected; try the next song."}
  </EmptyStage>;
  if (lyrics.status === "unsupported") return <EmptyStage title="Lyrics unavailable">
    {lyrics.message || "This lyrics format isn’t supported. Playback continues on your player."}
  </EmptyStage>;
  return <EmptyStage title="Just the music, for now">
    {lyrics.message || "No lyrics were found for this song. The next song will appear automatically."}
  </EmptyStage>;
}

function Artwork({ url, title, album }: { url: string | null; title: string; album: string }) {
  const [failed, setFailed] = useState(false);
  const localUrl = localArtworkUrl(url);
  return <div className={`artwork ${localUrl && !failed ? "" : "artwork-fallback"}`}>
    {localUrl && !failed
      ? <img src={localUrl} alt={`Cover art for ${album || title}`} onError={() => setFailed(true)} />
      : <div className="fallback-composition" role="img" aria-label={title ? `No cover art for ${title}` : "Waiting for a song"}>
        <span className="record-groove" aria-hidden="true"><span>♪</span></span>
        <span className="fallback-label">{title ? "No cover art" : "Your room. Your music."}</span>
      </div>}
  </div>;
}

const viewModes: { value: ViewMode; label: string }[] = [
  { value: "now-playing", label: "Now Playing" },
  { value: "lyrics", label: "Lyrics" },
  { value: "split", label: "Split" },
  { value: "ambient", label: "Ambient" },
  { value: "vinyl", label: "Vinyl" },
];

export function App() {
  const display = useRef<HTMLDivElement>(null);
  const [kiosk] = useState(isExplicitKiosk);
  const playback = usePlayback();
  const { snapshot, positionMs, stale, cleared, transportError } = playback;
  const command = useLocalCommand();
  const { execute, pending, error, notice } = command;
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [confirmStandby, setConfirmStandby] = useState(false);
  const standbyTrigger = useRef<HTMLButtonElement>(null);
  const standbyCancel = useRef<HTMLButtonElement>(null);
  const standbyWasOpen = useRef(false);
  const settings = useRef<HTMLDetailsElement>(null);
  const libraryDetails = useRef<HTMLDetailsElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lineInOpen, setLineInOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const track = snapshot?.track;
  const longMetadata = track && [track.title, track.artist, track.album].some((value) => value.length > 65);
  const offset = snapshot?.visualOffsetMs ?? 0;
  const viewMode = snapshot?.viewMode ?? "split";
  const lyricFollowMode = snapshot?.lyricFollowMode ?? "smooth";
  const ambientMode = viewMode === "ambient" && !lineInOpen;
  const vinylMode = viewMode === "vinyl" && !lineInOpen;
  const quietMode = ambientMode || vinylMode;
  const independentMode = lineInOpen || vinylMode;
  const vinyl = snapshot?.vinyl ?? DEFAULT_VINYL;
  const ambient = snapshot?.ambient ?? DEFAULT_AMBIENT;
  const library = useAmbientLibrary(ambientMode, libraryOpen);
  const controls = useAmbientControls(quietMode, pending || libraryOpen || settingsOpen || toolsOpen);
  const localDisabled = !snapshot || transportError !== null || pending;
  const disabled = localDisabled || stale;
  const offsetText = `${offset > 0 ? "+" : ""}${offset} ms`;
  const navigation = useCallback((action: NavigationAction, target?: HTMLElement | null, remote = false) => {
    if (action.repeat && (action.key === "select" || action.key === "back")) return true;
    if (quietMode && !controls.visible) {
      controls.reveal(true);
      return true;
    }
    if (quietMode) controls.reveal();
    return display.current ? navigate(display.current, action, target, { allowExternalLinks: !remote }) : false;
  }, [quietMode, controls.visible, controls.reveal]);
  const remoteConnection = useRemoteNavigation(kiosk, (action) => {
    // Commit each real action before the next event in a coalesced stream chunk.
    flushSync(() => navigation(action, undefined, true));
  });
  const kioskReportError = useKioskDiagnostics(kiosk, remoteConnection);

  useEffect(() => {
    if (confirmStandby) focusNavigation(standbyCancel.current);
    else if (standbyWasOpen.current) focusNavigation(standbyTrigger.current);
    standbyWasOpen.current = confirmStandby;
  }, [confirmStandby]);

  useEffect(() => {
    if (!ambientMode) setLibraryOpen(false);
  }, [ambientMode]);

  const toggleFullscreen = useCallback(async () => {
    setFullscreenError(null);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else throw new Error("Fullscreen is unavailable in this browser. Use your browser’s fullscreen or kiosk mode.");
    } catch (failure) {
      setFullscreenError(kiosk
        ? "Fullscreen needs a browser gesture. The TV browser’s kiosk mode already handles fullscreen; use an admin browser to change it."
        : failure instanceof Error ? failure.message : "Fullscreen could not be opened.");
    }
  }, [kiosk]);

  const changeOffset = useCallback((value: number) => {
    if (localDisabled || independentMode) return;
    void execute("/api/settings", { visualOffsetMs: Math.max(-30_000, Math.min(30_000, value)) }, "Timing offset saved.");
  }, [localDisabled, execute, independentMode]);

  const changeView = useCallback((value: ViewMode) => {
    setLineInOpen(false);
    if (localDisabled || value === viewMode) return;
    void execute("/api/settings", { viewMode: value }, "Display view saved.");
  }, [localDisabled, execute, viewMode]);

  const changeLyricFollow = (value: LyricFollowMode) => {
    if (localDisabled || value === lyricFollowMode) return;
    void execute("/api/settings", { lyricFollowMode: value }, "Lyric follow saved.");
  };

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    const keydown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = keyboardNavigationKey(event.key);
      if (key) {
        const target = event.target instanceof HTMLElement ? event.target : undefined;
        if (navigation({ key, repeat: event.repeat }, target)) event.preventDefault();
        return;
      }
      if (event.repeat) return;
      if (quietMode && !controls.visible) {
        controls.reveal(true);
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", " "].includes(event.key)) {
          event.preventDefault();
        }
        return;
      }
      if (quietMode) controls.reveal();
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest(".plain-lyrics, .timed-viewport, .now-playing, [contenteditable]")
        || /^(INPUT|TEXTAREA|SELECT|BUTTON|SUMMARY|A)$/.test(target.tagName))) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        void toggleFullscreen();
      } else if (event.key === "[" && !quietMode) {
        event.preventDefault();
        changeOffset(offset - 100);
      } else if (event.key === "]" && !quietMode) {
        event.preventDefault();
        changeOffset(offset + 100);
      } else if (/^[12345]$/.test(event.key)) {
        event.preventDefault();
        changeView(viewModes[Number(event.key) - 1]!.value);
      }
    };
    document.addEventListener("fullscreenchange", changed);
    window.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("fullscreenchange", changed);
      window.removeEventListener("keydown", keydown);
    };
  }, [toggleFullscreen, changeOffset, changeView, offset, quietMode, controls.visible, controls.reveal, navigation]);

  const demo = (action: "play" | "pause" | "stop" | "next" | "seek", seekTo?: number) => {
    void execute("/api/demo", { action, ...(seekTo === undefined ? {} : { positionMs: seekTo }) }, "Demo updated.");
  };
  const cec = (command: CecCommand) => {
    setConfirmStandby(false);
    void execute("/api/cec", { command }, "TV command sent.");
  };
  const lyricsLabel = snapshot?.lyrics.status === "timed" ? "Timed lyrics"
    : snapshot?.lyrics.status === "plain" ? "Unsynced lyrics"
      : snapshot?.lyrics.status === "loading" ? "Loading lyrics"
        : snapshot?.lyrics.status === "error" ? "Lyrics error"
          : snapshot?.lyrics.status === "unsupported" ? "Unsupported lyrics" : "No lyrics";
  const stateLabel = stale ? "Connection stale" : !snapshot ? "Connecting"
    : snapshot.playback === "playing" ? "Playing" : snapshot.playback === "paused" ? "Paused" : "Ready";
  const progressPosition = track?.durationMs ? Math.min(positionMs, track.durationMs) : 0;

  return <div ref={display} className={`display view-${lineInOpen ? "line-in" : viewMode} ${stale && !independentMode ? "is-stale" : ""} ${ambientMode && !controls.visible ? "ambient-quiet" : ""} ${vinylMode && !controls.visible ? "vinyl-quiet" : ""}`}>
    <header className="display-header" hidden={ambientMode && !controls.visible}
      inert={toolsOpen || (vinylMode && !controls.visible)} aria-hidden={toolsOpen || (vinylMode && !controls.visible)}>
      <a className="skip-link" href="#display-content">Skip to {independentMode ? "line-in album" : ambientMode ? "scene" : viewMode === "now-playing" ? "now playing" : "lyrics"}</a>
      <div className="view-switcher" role="tablist" aria-label="Display view" aria-busy={pending}>
        {viewModes.map(({ value, label }) => <button key={value} id={`tab-${value}`} role="tab"
          aria-selected={!lineInOpen && viewMode === value} aria-controls="display-content" tabIndex={!lineInOpen && viewMode === value ? 0 : -1}
          disabled={viewMode !== value && (!snapshot || transportError !== null)} aria-disabled={localDisabled}
          onClick={() => changeView(value)}>{label}</button>)}
        <button id="tab-line-in" role="tab" aria-selected={lineInOpen}
          aria-controls="display-content" tabIndex={lineInOpen ? 0 : -1}
          onClick={() => setLineInOpen(true)}>Line-in album</button>
      </div>
      <div className="header-status">
        {independentMode ? <span className="connection-status">Independent line-in view</span>
          : ambientMode ? <span className="connection-status">Ambient · No audio</span> : <>
          {snapshot?.demo && <span className="demo-badge">Demo mode · no audio</span>}
          <span className={`connection-status ${stale ? "warning" : ""}`} role="status">
            <span className="status-dot" aria-hidden="true" />{stateLabel}
          </span>
        </>}
      </div>
    </header>

    <main id="display-content" className={ambientMode ? "ambient-stage" : "listening-stage"} role="tabpanel" inert={toolsOpen}
      aria-labelledby={`tab-${lineInOpen ? "line-in" : viewMode}`} tabIndex={-1}
      onPointerDown={quietMode ? (event) => {
        if (!(event.target instanceof HTMLElement) || !event.target.closest("button, summary, input, textarea, select, a, [data-navigation-scroll]")) event.currentTarget.focus();
      } : undefined}>
      {lineInOpen ? <LineInAlbumView /> : vinylMode ? <VinylView settings={vinyl}
        controlsVisible={controls.visible} disabled={localDisabled}
        onSettings={(patch) => { if (!localDisabled) void execute("/api/settings", { vinyl: patch }, "Vinyl settings saved."); }}
        renderCorrection={(view, refresh) => <AlbumEditionCorrection binding={view.edition?.binding ?? null}
          original={view.edition?.original ?? null} corrected={view.edition?.corrected ?? false}
          provenance={view.edition?.provenance} fallback={view.edition?.fallback} onChanged={refresh} />} />
        : ambientMode ? <AmbientScene settings={ambient} images={library.images} onIssue={library.setSceneIssue} /> : <>
      <section className={`now-playing${longMetadata ? " has-long-metadata" : ""}`} aria-label="Current song"
        tabIndex={track ? 0 : undefined} data-navigation-scroll>
        <Artwork key={JSON.stringify([snapshot?.generation, track?.identity, track?.artworkUrl])}
          url={track?.artworkUrl ?? null} title={track?.title ?? ""} album={track?.album ?? ""} />
        <div className="track-metadata">
          <h1 className={(track?.title.length ?? 0) > 65 ? "long-title" : undefined}>{track?.title || "A room for music."}</h1>
          <p className="track-artist">{track ? track.artist || "Unknown artist" : "Your local listening display"}</p>
          {track?.album && <p className="track-album">{track.album}</p>}
          {viewMode === "now-playing" && track && <p className="listening-note">
            {stale ? "The last known song. Reconnecting automatically."
              : snapshot?.playback === "idle" ? "Playback stopped. Ready for your next song."
              : snapshot?.playback === "paused" ? `Paused · Resume on ${snapshot.demo ? "the demo controls" : "your player"}.`
                : snapshot?.demo ? "Synthetic demo · No audio is playing."
                  : "Playing on your Music Assistant player."}
          </p>}
        </div>
      </section>
      {viewMode !== "now-playing" && <section id="lyrics" className="lyrics-stage" aria-label="Lyrics">
        <div className="stage-caption">
          <span className="lyrics-label"><span className="lyrics-symbol" aria-hidden="true">≋</span>{track && snapshot?.playback !== "idle" ? lyricsLabel : "Your local lyrics display"}</span>
          {track && !stale && snapshot?.playback === "paused" && <span>Resume on {snapshot.demo ? "the demo controls" : "your player"}</span>}
        </div>
        <LyricsStage {...playback} />
      </section>}
      {viewMode === "now-playing" && (!track || cleared) && <section className="now-playing-empty">
        <LyricsStage {...playback} />
      </section>}
      </>}
    </main>
    {!ambientMode && !independentMode && <div className="service-messages">
      {stale && <div className="stale-banner" role="status">
        <strong>{cleared ? "Still reconnecting" : viewMode === "now-playing" ? "Display frozen" : "Lyrics frozen"}</strong>
        <span>{transportError || snapshot?.message || "The player connection is stale. Reconnecting automatically…"}</span>
      </div>}
      {!stale && snapshot?.message && <p className="source-message">{snapshot.message}</p>}
    </div>}

    <footer className="display-footer" hidden={ambientMode && !controls.visible}
      inert={toolsOpen || (vinylMode && !controls.visible)} aria-hidden={toolsOpen || (vinylMode && !controls.visible)}>
      {!ambientMode && !independentMode && <div className="playback-timeline" aria-label="Playback progress">
        <span className="time">{track ? timeLabel(positionMs) : "0:00"}</span>
        <progress className="progress-track" aria-label="Song position"
          max={track?.durationMs || 100} value={progressPosition}
          aria-valuemin={0} aria-valuemax={track?.durationMs || 100}
          aria-valuenow={Math.round(progressPosition)}
          aria-valuetext={track ? `${timeLabel(positionMs)}${track.durationMs ? ` of ${timeLabel(track.durationMs)}` : ""}` : "No song playing"} />
        <span className="time remaining" aria-label={track?.durationMs ? `${timeLabel(track.durationMs - progressPosition)} remaining` : "Duration unknown"}>
          {track?.durationMs ? `−${timeLabel(track.durationMs - progressPosition)}` : "–:––"}</span>
      </div>}

      {!ambientMode && !independentMode && snapshot?.demo && <div className="demo-controls" aria-label="Demo playback controls">
        <span className="demo-description">Synthetic demo</span>
        <button disabled={disabled} onClick={() => demo(snapshot.playback === "playing" ? "pause" : "play")}>
          {snapshot.playback === "playing" ? "Pause demo" : "Play demo"}
        </button>
        <button disabled={disabled || snapshot.playback === "idle"} onClick={() => demo("stop")}>Stop demo</button>
        <button disabled={disabled || !track || snapshot.playback === "idle"}
          onClick={() => demo("seek", Math.max(0, positionMs - 10_000))}>−10 sec</button>
        <button disabled={disabled || !track || snapshot.playback === "idle"}
          onClick={() => demo("seek", Math.min(track?.durationMs ?? Infinity, positionMs + 10_000))}>+10 sec</button>
        <button disabled={disabled} onClick={() => demo("next")}>Next demo song</button>
      </div>}

      <div className="display-tools">
        <span className="local-note">{independentMode ? "Album identification only · No playback controls" : ambientMode ? "Your room. A little quieter." : track && snapshot?.precision === "ma-queue"
          ? "Approximate queue-event sync" : track && snapshot?.precision === "ma-player"
            ? "External source · Approximate player timing" : "Local display · No audio output"}</span>
        <div className="tool-actions">
          <button type="button" aria-haspopup="dialog" aria-expanded={toolsOpen} onClick={() => {
            setConfirmStandby(false);
            if (settings.current) settings.current.open = false;
            if (libraryDetails.current) libraryDetails.current.open = false;
            setSettingsOpen(false);
            setLibraryOpen(false);
            setToolsOpen(true);
          }}>Tools</button>
          {ambientMode && <details ref={libraryDetails} className="ambient-library" onToggle={(event) => {
            setLibraryOpen(event.currentTarget.open);
            if (event.currentTarget.open && settings.current) {
              settings.current.open = false;
              setSettingsOpen(false);
            }
          }}>
            <summary>Scene library</summary>
            <AmbientLibraryControls settings={ambient} library={library}
              command={command} disabled={localDisabled} kiosk={kiosk} />
          </details>}
          <details ref={settings} className="settings" onToggle={(event) => {
            setSettingsOpen(event.currentTarget.open);
            if (event.currentTarget.open && libraryDetails.current) {
              libraryDetails.current.open = false;
              setLibraryOpen(false);
            }
            if (!event.currentTarget.open) setConfirmStandby(false);
          }}>
            <summary>Display settings {!ambientMode && !independentMode && <span className="offset-summary">{offsetText}</span>}</summary>
            <div className="settings-panel" tabIndex={0} data-navigation-scroll aria-label="Display settings help">
              {!independentMode && <section aria-labelledby="follow-heading">
                <h2 id="follow-heading">Lyric follow</h2>
                <p>Instant centers each cue without animation, fades or changing font weight. Try it for jerky scrolling on a 4K TV. Photos and lyric timing stay unchanged.</p>
                <div className="follow-mode-controls" role="group" aria-label="Lyric follow mode">
                  <button disabled={localDisabled} aria-pressed={lyricFollowMode === "smooth"}
                    onClick={() => changeLyricFollow("smooth")}>Smooth</button>
                  <button disabled={localDisabled} aria-pressed={lyricFollowMode === "instant"}
                    onClick={() => changeLyricFollow("instant")}>Instant (low-cost)</button>
                </div>
                <p>Saved on the local service for every display. Reduced motion always uses instant follow. Focus, touch or scroll timed lyrics to pause following; select Resume lyric follow to rejoin.</p>
              </section>}
              {!ambientMode && !independentMode && <section aria-labelledby="timing-heading">
                <h2 id="timing-heading">Make the words meet the music</h2>
                <p>Adjust this screen, not playback. A positive offset shows lyrics earlier. Saved on the local service.</p>
                {snapshot?.precision === "ma-queue" && <p>Timing follows approximate Music Assistant queue events, not the Sendspin audio clock.</p>}
                {snapshot?.precision === "ma-player" && <p>External-source metadata and approximate timing come from Music Assistant, not the Sendspin audio clock. Lyrics require an exact track URI and a reliable playback clock.</p>}
                <div className="offset-controls">
                  <button disabled={localDisabled || offset <= -30_000} onClick={() => changeOffset(offset - 100)} aria-label="Show lyrics 100 milliseconds later">−100 ms</button>
                  <output aria-label="Visual offset">{offsetText}</output>
                  <button disabled={localDisabled || offset >= 30_000} onClick={() => changeOffset(offset + 100)} aria-label="Show lyrics 100 milliseconds earlier">+100 ms</button>
                  <button disabled={localDisabled || offset === 0} onClick={() => changeOffset(0)}>Reset offset</button>
                </div>
              </section>}
              <section aria-labelledby="tv-heading">
                <h2 id="tv-heading">TV controls</h2>
                <p>{snapshot?.cec.message || "HDMI-CEC is off by default. Enable it in the local service configuration if supported."}</p>
                {snapshot?.cec.enabled && <div className="cec-controls">
                  <button disabled={localDisabled} onClick={() => cec("wake")}>Wake TV</button>
                  <button disabled={localDisabled} onClick={() => cec("active-source")}>Use this input</button>
                  {!confirmStandby
                    ? <button ref={standbyTrigger} disabled={localDisabled || !snapshot.cec.available || !snapshot.cec.owned} onClick={() => setConfirmStandby(true)}>TV standby…</button>
                    : <div className="standby-confirmation" data-navigation-dialog><span>Put the TV in standby?</span>
                      <button disabled={localDisabled || !snapshot.cec.available || !snapshot.cec.owned} onClick={() => cec("standby")}>Confirm standby</button>
                      <button ref={standbyCancel} data-navigation-cancel onClick={() => setConfirmStandby(false)}>Cancel</button>
                    </div>}
                </div>}
                {snapshot?.cec.enabled && !snapshot.cec.owned && <p className="cec-ownership-note">Standby is unavailable because this adapter cannot verify active-source ownership.</p>}
              </section>
              <KioskDiagnosticsPanel reportError={kioskReportError} />
              <section aria-labelledby="remote-heading">
                <h2 id="remote-heading">TV remote navigation</h2>
                {snapshot?.cec.remote && <CecDiagnostics remote={snapshot.cec.remote} />}
                <p>{!snapshot?.cec.remote?.enabled ? "Remote navigation is off. Enable it in the local service configuration, then use the TV’s kiosk display."
                  : !kiosk ? "Remote navigation is reserved for the TV’s kiosk display. This admin browser does not receive remote keys."
                    : remoteConnection === "connected" ? snapshot.cec.remote.listening
                      ? "Remote connected. Use the TV’s arrows, OK and Back to control this display."
                      : "Kiosk connected. Waiting for the TV’s HDMI-CEC remote input."
                    : remoteConnection === "waiting" ? "Another kiosk display owns the remote. Waiting for it to disconnect; this page will not take over."
                      : remoteConnection === "paused" ? "Remote paused while this page is hidden."
                        : "Connecting the kiosk remote. Retrying automatically; keyboard controls still work."}</p>
                <p>Arrows move focus. OK selects. Back closes the innermost panel and returns focus. Up / down scroll a focused reading pane; left / right leave it.
                  In Scene library, left / right adjust seconds; up / down leave the field. The first key reveals hidden Ambient or Vinyl controls without selecting anything.</p>
              </section>
              <p className="keyboard-help"><kbd>← ↑ ↓ →</kbd> move focus <span>·</span> <kbd>Enter / Space</kbd> select<br />
                <kbd>1 / 2 / 3 / 4 / 5</kbd> Now Playing / Lyrics / Split / Ambient / Vinyl<br />
                <kbd>F</kbd> fullscreen <span>·</span> {!quietMode && !independentMode && <><kbd>[</kbd> later <span>·</span> <kbd>]</kbd> earlier <span>·</span></>} <kbd>Esc</kbd> close panel / show controls</p>
            </div>
          </details>
          <button onClick={() => void toggleFullscreen()}>{fullscreen ? "Exit fullscreen" : "Fullscreen"} <span aria-hidden="true">⛶</span></button>
          {quietMode && !libraryOpen && !settingsOpen && !toolsOpen && <button onClick={() => {
            document.getElementById("display-content")?.focus();
            controls.hide();
          }} disabled={pending || libraryOpen || settingsOpen || toolsOpen}>Hide controls</button>}
        </div>
      </div>
      <div className="command-feedback">
        {vinylMode && <p className="ambient-help">Move, tap, or press a key for controls. {transportError ? "Display service unavailable; saved album and line-in status remain independent." : "Controls fade after a quiet moment."}</p>}
        {ambientMode && <>
          <p className="ambient-help">Move, tap, or press a key for controls. They hide after a quiet moment.</p>
          {!ambient.selectedIds.some((id) => library.images.some((image) => image.id === id)) &&
            <p role="status">No selected photos are available. Showing {BUILTIN_BACKGROUNDS[0]!.title} as a fallback; your selection is unchanged.</p>}
          {library.sceneIssue && <p role="status">{library.sceneIssue}</p>}
          {transportError && <p role="status">Local service unavailable. Your scene keeps going; controls will reconnect automatically.</p>}
          {library.error && !libraryOpen && <p role="alert">{library.error}</p>}
        </>}
        {((error && !libraryOpen) || fullscreenError) && <p role="alert">{fullscreenError || error}</p>}
        {!libraryOpen && <p role="status">{pending ? "Sending to local service…" : notice}</p>}
      </div>
    </footer>
    {toolsOpen && <ToolsPanel onClose={() => setToolsOpen(false)}
      extraSections={[{ id: "journal", title: "Journal", content: <ListeningJournal /> }]} />}
  </div>;
}
