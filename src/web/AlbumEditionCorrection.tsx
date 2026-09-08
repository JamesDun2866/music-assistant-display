import { useEffect, useId, useRef, useState } from "react";
import { editionSearchResponseSchema, editionPreviewResponseSchema, editionMutationResponseSchema,
  type EditionBinding, type EditionSearchResponse, type EditionPreviewResponse } from "../shared/album-editions.js";
import { useLocalCommand } from "./useLocalCommand.js";
import type { FallbackStatus, ProviderProvenance } from "../shared/album-provider.js";
import "./album-editions.css";

export interface AlbumEditionCorrectionProps {
  binding: EditionBinding | null;
  original: { title: string; artist: string; country?: string } | null;
  corrected: boolean;
  provenance?: ProviderProvenance | null;
  fallback?: FallbackStatus;
  onChanged: () => void;
}
export function AlbumEditionCorrection(props: AlbumEditionCorrectionProps) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return <div className="album-edition-control">
    <button ref={opener} type="button" disabled={!props.binding || !props.original} onClick={() => setOpen(true)}>
      {props.corrected ? "Change corrected edition" : "Correct album edition"}
    </button>
    {open && props.binding && props.original && <EditionDialog {...props}
      binding={props.binding} original={props.original} onClose={() => {
        setOpen(false);
        requestAnimationFrame(() => opener.current?.focus());
      }} />}
  </div>;
}
function EditionDialog({ binding, original, corrected, provenance, fallback, onChanged, onClose }:
  Omit<AlbumEditionCorrectionProps, "binding" | "original"> & {
    binding: EditionBinding; original: NonNullable<AlbumEditionCorrectionProps["original"]>; onClose: () => void;
  }) {
  const id = useId(), dialog = useRef<HTMLDivElement>(null);
  const initial = useRef(JSON.stringify(binding));
  const stale = initial.current !== JSON.stringify(binding);
  const [artist, setArtist] = useState(original.artist), [album, setAlbum] = useState(original.title);
  const [country, setCountry] = useState(original.country ?? "");
  const [provider, setProvider] = useState<"apple" | "musicbrainz">(
    fallback && (fallback.candidates.length > 0
      || ["confirmation-required", "no-match", "incomplete", "unavailable"].includes(fallback.state))
      ? "musicbrainz" : "apple");
  const [results, setResults] = useState<EditionSearchResponse | null>(null);
  const [preview, setPreview] = useState<EditionPreviewResponse | null>(null);
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const command = useLocalCommand();
  useEffect(() => { dialog.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  const disabled = command.pending || stale;
  const automatic = provenance?.origin === "automatic-catalog";
  const mutate = async (action: "confirm" | "remove") => {
    const ok = await command.execute(`/api/line-in-album/edition/${action}`, action === "confirm"
      ? { binding, previewToken: preview!.previewToken, confirm: true }
      : { binding, correctionRevision: binding.revision, confirm: true }, "Edition updated.",
    { accept: (data) => { editionMutationResponseSchema.parse(data); } });
    if (ok) { onChanged(); onClose(); }
  };
  return <div className="edition-backdrop">
    <div ref={dialog} className="edition-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      data-navigation-dialog onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const controls = [...dialog.current!.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <h2 id={`${id}-title`}>Correct album edition</h2>
      <p>Originally recognized: <strong>{original.title}</strong> — {original.artist}</p>
      {corrected && <p>Current display: Corrected catalog edition</p>}
      {automatic && <p>Current display: Automatically resolved catalog edition, not a manual correction.</p>}
      <p>This selects a catalog edition, not a verified physical pressing. Search sends artist and album text to
        {provider === "apple" ? " Apple" : " MusicBrainz"}, never audio. No API keys are required.</p>
      {stale && <p role="alert">The album or identification changed. Close and reopen this dialog.</p>}
      <div className="edition-scroll" data-navigation-scroll tabIndex={0}>
        {fallback && <section aria-label="Cached catalog candidates">
          <p>{fallback.message}</p>
          {fallback.candidates.length > 0 && <>
            <p>{fallback.candidates.length} cached candidate {fallback.candidates.length === 1 ? "edition" : "editions"}.
              Search MusicBrainz with the original names to review these candidates. Nothing is selected automatically.</p>
            <ul>{fallback.candidates.map((candidate) => <li key={candidate.release.provider === "musicbrainz"
              ? candidate.release.releaseId : `${candidate.release.country}-${candidate.release.collectionId}`}>
              {candidate.title} — {candidate.artist} · {candidate.country || "Country unknown"} · {candidate.date || "Date unknown"}
              {" · "}{candidate.format || "Format unknown"}{candidate.disambiguation && ` · ${candidate.disambiguation}`}
              {" · "}{candidate.release.provider === "musicbrainz" ? `MusicBrainz release ${candidate.release.releaseId}`
                : `Apple collection ${candidate.release.collectionId}`}
            </li>)}</ul>
          </>}
        </section>}
        <form onSubmit={(event) => {
          event.preventDefault(); setPreview(null); setResults(null); setRemoving(false);
          if (disabled) return;
          void command.execute("/api/line-in-album/edition/search", provider === "musicbrainz"
            ? { binding, artist, album, provider } : { binding, artist, album, country },
            "Search complete.", { timeoutMs: provider === "musicbrainz" ? 45000 : 15000,
              accept: (data) => setResults(editionSearchResponseSchema.parse(data)) });
        }}>
          <div role="group" aria-label="Catalog provider">
            {(["apple", "musicbrainz"] as const).map((choice) => <button key={choice} type="button"
              aria-pressed={provider === choice} disabled={disabled} onClick={() => {
                setProvider(choice);
                setResults(null); setPreview(null); setRemoving(false); setFailedArtwork(null);
              }}>{choice === "apple" ? "Apple" : "MusicBrainz"}</button>)}
          </div>
          <label htmlFor={`${id}-artist`}>Artist</label>
          <input id={`${id}-artist`} value={artist} maxLength={256} required disabled={disabled}
            onChange={(event) => setArtist(event.target.value)} />
          <label htmlFor={`${id}-album`}>Album</label>
          <input id={`${id}-album`} value={album} maxLength={256} required disabled={disabled}
            onChange={(event) => setAlbum(event.target.value)} />
          {provider === "apple" && <><label htmlFor={`${id}-country`}>Apple storefront country (two-letter code)</label>
          <input id={`${id}-country`} value={country} pattern="[a-z]{2}" minLength={2} maxLength={2}
            placeholder="gb" autoCapitalize="none" required disabled={disabled}
            onChange={(event) => setCountry(event.target.value.toLowerCase())} /></>}
          <button type="submit" disabled={disabled || !artist.trim() || !album.trim()
            || provider === "apple" && !/^[a-z]{2}$/.test(country)}>
            Search {provider === "apple" ? "Apple" : "MusicBrainz"}</button>
        </form>
        {results && <section aria-label="Search results">
          {results.results.length === 0 && <p>No matching albums found.</p>}
          <ul>{results.results.map((result) => <li key={"releaseId" in result ? result.releaseId : result.collectionId}>
            <span>{result.title} — {result.artist} ({result.country?.toUpperCase() || "Country unknown"})</span>
            {"releaseId" in result && <p>{result.date || "Date unknown"} · {result.format || "Format unknown"}
              {result.disambiguation && ` · ${result.disambiguation}`} · MusicBrainz release {result.releaseId}</p>}
            <button type="button" disabled={disabled} onClick={() => {
              setPreview(null); setRemoving(false); setFailedArtwork(null);
              void command.execute("/api/line-in-album/edition/preview", "releaseId" in result
                ? { binding, searchToken: results.searchToken, releaseId: result.releaseId, provider: "musicbrainz" }
                : { binding, searchToken: results.searchToken, collectionId: result.collectionId, country: result.country }, "Preview ready.",
              { timeoutMs: "releaseId" in result ? 45000 : 15000,
                accept: (data) => setPreview(editionPreviewResponseSchema.parse(data)) });
            }}>Preview {result.title}</button>
          </li>)}</ul>
        </section>}
        {preview && <section aria-label="Exact edition preview">
          <h3>Selected catalog edition: {preview.title}</h3>
          <p>{preview.artist} · {preview.country?.toUpperCase() || "Country unknown"} · {"releaseId" in preview
            ? `MusicBrainz release ${preview.releaseId}` : `Apple collection ${preview.collectionId}`}</p>
          {"releaseId" in preview && <p>{preview.date || "Date unknown"} · {preview.format || "Format unknown"}
            {preview.disambiguation && ` · ${preview.disambiguation}`}</p>}
          <p><a href={preview.provenance?.catalogUrl ?? ("releaseId" in preview
            ? `https://musicbrainz.org/release/${preview.releaseId}`
            : `https://music.apple.com/${preview.country}/album/${preview.collectionId}`)} target="_blank" rel="noreferrer">
            Exact catalog edition</a>
            {preview.provenance?.artwork?.provider === "cover-art-archive" && <> · <a
              href={`https://musicbrainz.org/release/${preview.provenance.artwork.releaseId}/cover-art`}
              target="_blank" rel="noreferrer">Cover Art Archive for this release</a></>}</p>
          {preview.artworkUrl && failedArtwork !== preview.artworkUrl
            ? <img className="edition-cover" src={preview.artworkUrl} alt={`Cover for ${preview.title}`}
              onError={() => setFailedArtwork(preview.artworkUrl)} />
            : <p role="status">Cover unavailable for this edition. The original cover will not be used.</p>}
          <p>{preview.scope === "remembered"
            ? "Remembered for this source and exact original Apple album and storefront."
            : "Current album only — not remembered for future identifications. Expires on the next successful identification."}</p>
          <h4>Complete tracklist</h4>
          <ol>{preview.tracklist.tracks.map((track) => <li key={`${track.disc}-${track.number}`}>
            Disc {track.disc}, track {track.number}: {track.title}
          </li>)}</ol>
          <button type="button" disabled={disabled} onClick={() => void mutate("confirm")}>Confirm this edition</button>
        </section>}
        {(corrected || automatic) && <section aria-label={automatic ? "Restore original album" : "Remove correction"}>
          {!removing ? <button type="button" disabled={disabled} onClick={() => {
            setRemoving(true); setPreview(null);
          }}>{automatic ? "Restore original album" : "Remove correction"}</button> : <>
            <p>{automatic ? "Remove the automatic catalog resolution and restore the original recognized album?"
              : "Remove the saved correction and restore the original recognized album?"}</p>
            <button type="button" disabled={disabled} onClick={() => void mutate("remove")}>Confirm removal</button>
            <button type="button" disabled={command.pending} onClick={() => setRemoving(false)}>
              {automatic ? "Keep catalog resolution" : "Keep correction"}</button>
          </>}
        </section>}
        {provider === "musicbrainz" && <p><a href="https://musicbrainz.org/doc/About/Data_License"
          target="_blank" rel="noreferrer">MusicBrainz data licenses</a>: core data CC0; supplementary data CC BY-NC-SA.
          {" "}<a href="https://musicbrainz.org/doc/Cover_Art_Archive"
            target="_blank" rel="noreferrer">Cover Art Archive rights</a>: images retain their individual copyrights, not a blanket CC0 license.</p>}
      </div>
      {command.pending && <p role="status">Working…</p>}
      {command.error && <p role="alert">{command.error}</p>}
      <button type="button" data-navigation-cancel onClick={onClose}>Close</button>
    </div>
  </div>;
}
