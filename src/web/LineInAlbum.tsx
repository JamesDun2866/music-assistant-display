import { useEffect, useState } from "react";
import { albumViewSchema, type AlbumView } from "../shared/line-in-album.js";
import { useLocalCommand } from "./useLocalCommand.js";

const labels: Record<AlbumView["state"], string> = {
  "not-configured": "Line-in album display is not configured",
  offline: "Line-in source unavailable",
  disabled: "Album recognition is off",
  idle: "Waiting for active line-in",
  armed: "Waiting for audible input",
  sampling: "Listening for an album",
  recognizing: "Identifying album",
  identified: "Recognition succeeded",
  unavailable: "Album not identified",
};

export function LineInAlbumView() {
  const [view, setView] = useState<AlbumView | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const command = useLocalCommand();
  useEffect(() => { setFailedImage(null); }, [view?.album?.artworkUrl]);
  useEffect(() => {
    let alive = true;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch("/api/line-in-album", {
          cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
        });
        if (!response.ok) throw new Error("album_unavailable");
        const result = albumViewSchema.parse(await response.json());
        if (!alive) return;
        clearTimeout(expiry);
        if (result.expiresAt <= Date.now()) {
          setView({ ...result, state: "offline", retry: null });
        } else {
          setView(result);
          expiry = setTimeout(() => setView((previous) => previous
            ? { ...previous, state: "offline", retry: null } : null),
            Math.max(0, Math.min(4000, result.expiresAt - Date.now())));
        }
      } catch {
        if (alive) setView((previous) => previous ? { ...previous, state: "offline", retry: null } : null);
      } finally {
        if (alive) timer = setTimeout(() => { void poll(); }, 750);
      }
    };
    void poll();
    return () => { alive = false; controller.abort(); clearTimeout(timer); clearTimeout(expiry); };
  }, []);
  const album = view?.album;
  const tracks = view?.tracklist;
  const complete = album && tracks?.status === "complete";
  const title = complete ? tracks.title! : album?.title;
  const artist = complete ? tracks.artist : album?.artist;
  return <section className="line-in-album" aria-label="Line-in album">
    <header className="album-header">
      <div className="album-title-block">
        <p className="stage-caption" role="status">
          {album && <><span>Last identified album</span><span aria-hidden="true"> · </span></>}
          <span>{view ? labels[view.state] : "Line-in source unavailable"}</span>
        </p>
        <h1>{title || (view ? labels[view.state] : "Line-in source unavailable")}</h1>
        {artist && <p className="track-artist">{artist}</p>}
      </div>
      <button type="button" disabled={!view?.retry || command.pending}
        onClick={() => { if (view?.retry) void command.execute("/api/line-in-album/retry", view.retry,
          "Retry requested. Listening for a fresh 12-second sample."); }}>
        Retry identification
      </button>
      {command.error && <p className="album-command-message" role="alert">{command.error}</p>}
      {command.notice && <p className="album-command-message" role="status">{command.notice}</p>}
      {view?.cacheError && <p className="album-command-message" role="alert">{view.cacheError}</p>}
    </header>
    {album ? <>
      <div className="album-cover">
        <div className="artwork">
          {album.artworkUrl && failedImage !== album.artworkUrl
            ? <img src={album.artworkUrl} alt={`Cover art for ${title}`}
              onError={() => setFailedImage(album.artworkUrl)} />
            : <p>No cover art</p>}
        </div>
      </div>
      <section className="album-tracklist" aria-label="Album tracklist" data-navigation-scroll tabIndex={0}>
        <h2>{complete ? "Full catalog tracklist" : "Tracklist"}</h2>
        {complete ? <>
          <p>{tracks.tracks.length} tracks · {tracks.discCount} {tracks.discCount === 1 ? "disc" : "discs"}</p>
          {Array.from({ length: tracks.discCount! }, (_, index) => index + 1).map((disc) =>
            <section key={disc} aria-label={`Disc ${disc}`}>
              {tracks.discCount! > 1 && <h3>Disc {disc}</h3>}
              <ol role="list">
                {tracks.tracks.filter((track) => track.disc === disc).map((track) =>
                  <li key={track.number}><span className="album-track-number">{track.number}.</span>
                    <span>{track.title}</span></li>)}
              </ol>
            </section>)}
        </> : <p role="status">{tracks?.message || "Tracklist unavailable"}</p>}
      </section>
    </> : null}
    <div className="album-notes">
      <p>Independent local line-in view, not your selected Music Assistant player.</p>
      <p>Catalog release only: physical edition is not verified. No current-track highlighting, lyrics or playback timing.</p>
      {view?.state === "disabled" && <p>Enable explicitly with recognition-enable; your choice is remembered across restarts.</p>}
      <p>The last identified album stays until another album is identified, including across reboots.</p>
      <p>Retry needs recognition enabled and active line-in audio; it never starts playback or recording.</p>
      {view?.state === "unavailable" && <p>Retry explicitly, or wait for five continuous seconds of silence and new audible input.</p>}
    </div>
  </section>;
}
