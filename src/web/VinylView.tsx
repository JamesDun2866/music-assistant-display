import { useEffect, useState, type ReactNode } from "react";
import type { AlbumView } from "../shared/line-in-album.js";
import type { VinylSettings } from "../shared/vinyl.js";
import { useLineInAlbum } from "./useLineInAlbum.js";
import { useLocalCommand } from "./useLocalCommand.js";
import { useSourceTelemetry } from "./useSourceTelemetry.js";
import { StereoMeters } from "./StereoMeters.js";
import { AlbumCatalogStatus } from "./AlbumCatalogStatus.js";
import "./vinyl.css";

const statusLabels: Record<AlbumView["state"], string> = {
  "not-configured": "Line-in is not configured",
  offline: "Line-in source unavailable",
  disabled: "Album recognition is off",
  idle: "Waiting for active line-in",
  armed: "Waiting for audible input",
  sampling: "Listening for an album",
  recognizing: "Identifying album",
  identified: "Recognition succeeded",
  unavailable: "Album not identified",
};

export function VinylView({ settings, controlsVisible, disabled, onSettings, renderCorrection }: {
  settings: VinylSettings;
  controlsVisible: boolean;
  disabled: boolean;
  onSettings: (patch: Partial<VinylSettings>) => void;
  renderCorrection?: (view: AlbumView, refresh: () => void) => ReactNode;
}) {
  const { view, refresh } = useLineInAlbum();
  const telemetry = useSourceTelemetry(settings.showMeters);
  const command = useLocalCommand();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const album = view?.album;
  const tracks = view?.tracklist;
  const complete = tracks?.status === "complete";
  const title = (complete ? tracks.title : album?.title) || "A place for your records";
  const artist = complete ? tracks.artist : album?.artist;
  const status = view ? statusLabels[view.state] : "Line-in source unavailable";
  const canRetry = Boolean(view?.retry && ["armed", "identified", "unavailable"].includes(view.state));
  useEffect(() => { setFailedImage(null); }, [album?.artworkUrl]);

  return <section className={`vinyl-view${settings.showTracklist ? " vinyl-with-tracks" : ""}`} aria-label="Vinyl album">
    <div className="vinyl-album" data-navigation-scroll tabIndex={0} aria-label="Last identified album">
      <div className="vinyl-cover">
        {album?.artworkUrl && failedImage !== album.artworkUrl
          ? <img src={album.artworkUrl} alt={`Cover art for ${title}`} onError={() => setFailedImage(album.artworkUrl)} />
          : <div className="vinyl-placeholder">{album ? "No cover art" : "Your next discovery belongs here."}</div>}
      </div>
      <div className="vinyl-metadata">
        <p className="vinyl-eyebrow">{view?.edition?.corrected ? "Corrected catalog edition"
          : view?.edition?.provenance?.origin === "automatic-catalog" ? "Automatically resolved catalog edition"
            : album ? "Last identified album" : "Independent line-in"}</p>
        <h1>{title}</h1>
        {artist && <p className="vinyl-artist">{artist}</p>}
      </div>
    </div>
    {settings.showTracklist && <section className="vinyl-tracklist" aria-label="Album tracklist" tabIndex={0} data-navigation-scroll>
      <h2>{complete ? "Full catalog tracklist" : "Tracklist"}</h2>
      {complete ? <>
        <p>{tracks.tracks.length} tracks · {tracks.discCount} {tracks.discCount === 1 ? "disc" : "discs"}</p>
        {Array.from({ length: tracks.discCount! }, (_, index) => index + 1).map((disc) =>
          <section key={disc} aria-label={`Disc ${disc}`}>
            {tracks.discCount! > 1 && <h3>Disc {disc}</h3>}
            <ol role="list">
              {tracks.tracks.filter((track) => track.disc === disc).map((track) =>
                <li key={track.number}><span className="vinyl-track-number">{track.number}.</span><span>{track.title}</span></li>)}
            </ol>
          </section>)}
      </> : <p>{tracks?.message || "Tracklist unavailable"}</p>}
    </section>}
    <div className="vinyl-bottom">
      <p className="vinyl-status" role="status">{status}</p>
      {settings.showMeters && <div className="vinyl-meters" aria-live="off"><StereoMeters telemetry={telemetry} compact /></div>}
      <div className="vinyl-controls" data-idle-controls inert={!controlsVisible} aria-hidden={!controlsVisible}>
        <button disabled={disabled} aria-pressed={settings.showTracklist}
          onClick={() => onSettings({ showTracklist: !settings.showTracklist })}>
          {settings.showTracklist ? "Hide tracklist" : "Show tracklist"}
        </button>
        <button disabled={disabled} aria-pressed={settings.showMeters}
          onClick={() => onSettings({ showMeters: !settings.showMeters })}>
          {settings.showMeters ? "Hide meters" : "Show meters"}
        </button>
        <details className="vinyl-details">
          <summary>Line-in details</summary>
          <div className="vinyl-details-panel" data-navigation-scroll tabIndex={0} aria-label="Line-in recognition details">
            <h2>Independent line-in</h2>
            <p>{status}. {album ? "Showing the last identified album, not a live current-track claim." : "No album has been identified yet."}</p>
            <p>The album stays through silence, failed recognition, disabled recognition and source restarts. It is separate from your Music Assistant player.</p>
            <p>Catalog edition only; the physical record is not verified. No track following, lyrics or playback timing.</p>
            <button disabled={!canRetry || command.pending}
              onClick={() => { if (canRetry && view?.retry) void command.execute("/api/line-in-album/retry", view.retry,
                "Retry requested. Listening for a fresh 12-second sample."); }}>Retry identification</button>
            <p>Retry needs recognition enabled and active input. It never enables recognition, starts playback or starts recording.</p>
            {view && renderCorrection?.(view, refresh)}
            {(view?.edition?.corrected || view?.edition?.provenance) && <p>
              Originally recognized: {view.edition.original.title} — {view.edition.original.artist}</p>}
            <AlbumCatalogStatus binding={view?.edition?.binding ?? null} status={view?.edition?.fallback}
              provenance={view?.edition?.provenance} onChanged={refresh} />
            {view?.edition?.scope === "current-album" && <p>
              Current identification only; not remembered for future matches.</p>}
            {command.error && <p role="alert">{command.error}</p>}
            {command.notice && <p role="status">{command.notice}</p>}
            {view?.cacheError && <p role="alert">{view.cacheError}</p>}
          </div>
        </details>
      </div>
    </div>
  </section>;
}
