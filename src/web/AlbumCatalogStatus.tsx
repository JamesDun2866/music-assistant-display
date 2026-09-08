import { useEffect, useState } from "react";
import type { EditionBinding } from "../shared/album-editions.js";
import { fallbackStatusSchema, type FallbackStatus, type ProviderProvenance } from "../shared/album-provider.js";
import { useLocalCommand } from "./useLocalCommand.js";

export function AlbumCatalogStatus({ binding, status, provenance, onChanged }: {
  binding: EditionBinding | null; status?: FallbackStatus; provenance?: ProviderProvenance | null; onChanged: () => void;
}) {
  const command = useLocalCommand();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!status?.retryAt || status.retryAt <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(status.retryAt - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [status?.retryAt]);
  const coolingDown = Boolean(status?.retryAt && status.retryAt > now);
  const waiting = status?.state === "loading" || coolingDown;
  return <div className="album-catalog-status">
    {provenance && <p>
      {provenance.origin === "automatic-catalog" ? "Catalog resolved via MusicBrainz" : "Manually selected catalog edition"}
      {" · "}<a href={provenance.catalogUrl} target="_blank" rel="noreferrer">
        {provenance.release.provider === "musicbrainz" ? "MusicBrainz release" : "Apple collection"}
      </a>
      {provenance.artwork?.provider === "cover-art-archive" && <>{" · "}
        <a href={`https://musicbrainz.org/release/${provenance.artwork.releaseId}/cover-art`}
          target="_blank" rel="noreferrer">Cover Art Archive</a></>}
    </p>}
    {status?.message && <p role="status">{status.message}</p>}
    {Boolean(status?.candidates.length) && <p>{status!.candidates.length} cached candidate editions.
      Use Correct album edition to compare release country, date, format and complete tracklist before choosing.</p>}
    {status?.retryAt && coolingDown && <p>Metadata retry available after {new Date(status.retryAt).toLocaleTimeString()}.
      Catalog rate limits apply; waiting does not start another request.</p>}
    {status && <button type="button" disabled={!binding || waiting || command.pending}
      onClick={() => {
        if (!binding) return;
        void command.execute("/api/line-in-album/edition/retry-metadata", { binding }, "Metadata lookup finished; no audio was sampled.",
          { timeoutMs: 45000, accept: (data) => { fallbackStatusSchema.parse(data); onChanged(); } });
      }}>Retry album metadata</button>}
    {(status || provenance?.release.provider === "musicbrainz") && <>
      <p>Metadata lookup sends artist and album text to the catalog, never audio. No API keys are required.
        It can use the cached album even when audio identification is unavailable. Catalog edition, not a verified physical pressing.</p>
      <p><a href="https://musicbrainz.org/doc/About/Data_License" target="_blank" rel="noreferrer">MusicBrainz data licenses</a>
        : core data CC0; supplementary data CC BY-NC-SA.{" "}
        <a href="https://musicbrainz.org/doc/Cover_Art_Archive" target="_blank" rel="noreferrer">Cover Art Archive rights</a>
        : images retain their individual copyrights; not all images are CC0.</p>
    </>}
    {command.error && <p role="alert">{command.error}</p>}
    {command.notice && <p role="status">{command.notice}</p>}
  </div>;
}
