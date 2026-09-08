import { useEffect, useRef, useState } from "react";
import { journalPageSchema, type JournalPage } from "../shared/listening-journal.js";
import { useLocalCommand } from "./useLocalCommand.js";
import "./listening-journal.css";

export function ListeningJournal() {
  const [page, setPage] = useState<JournalPage | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  const command = useLocalCommand();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void fetch(`/api/listening-journal${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {
      cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 409
        ? "The journal changed. Choose Latest to refresh." : "Journal unavailable. Check the local source and storage.");
      const value = journalPageSchema.parse(await response.json());
      if (!controller.signal.aborted) setPage(value);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Journal unavailable.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cursor, revision]);
  useEffect(() => {
    if (confirming) cancel.current?.focus();
  }, [confirming]);
  const closeConfirmation = () => { setConfirming(false); clear.current?.focus(); };
  const refresh = () => { setCursor(undefined); setRevision((value) => value + 1); };
  const erase = async () => {
    if (!page) return;
    if (await command.execute("/api/listening-journal/clear", { confirm: true, revision: page.revision }, "Journal cleared.")) {
      closeConfirmation(); refresh();
    }
  };
  return <section className="listening-journal" aria-labelledby="journal-heading">
    <h2 id="journal-heading">Listening journal</h2>
    <p>Album identifications from the last 90 days, not songs played, completed plays or listening time.
      Titles are preserved as originally recognized; edition corrections do not rewrite history.</p>
    <div className="journal-actions">
      <button onClick={refresh} disabled={loading || command.pending}>Latest / refresh</button>
      <a href="/api/listening-journal/export" download="listening-journal.json">Export JSON</a>
      <button ref={clear} onClick={() => setConfirming(true)} disabled={!page || loading || command.pending}>Clear journal</button>
    </div>
    {loading && <p role="status">Loading identifications...</p>}
    {error && <p role="alert">{error}</p>}
    {page?.message && <p role={page.status === "unavailable" ? "alert" : "status"}>{page.message}</p>}
    {command.error && <p role="alert">{command.error}</p>}
    {command.notice && <p role="status">{command.notice}</p>}
    {!loading && !error && page?.entries.length === 0 && <p>No retained identifications.</p>}
    {!loading && !error && <ol className="journal-entries" data-navigation-scroll tabIndex={0} aria-label="Original album identifications">
      {page?.entries.map((entry) => <li key={entry.id}>
        <JournalCover url={entry.artworkUrl} title={entry.title} />
        <div><h3>{entry.title}</h3><p>{entry.artist}</p>
          <time dateTime={new Date(entry.identifiedAt).toISOString()}>{new Date(entry.identifiedAt).toLocaleString()}</time>
          {entry.clockAdjusted && <p>Source clock differed; this date may be approximate.</p>}
        </div>
      </li>)}
    </ol>}
    <button disabled={loading || !page?.nextCursor || Boolean(error)}
      onClick={() => { if (page?.nextCursor) setCursor(page.nextCursor); }}>Older identifications</button>
    <p>Stored only on this appliance. Metadata expires after 90 days.
      Covers use a 256 MiB local cache; missing or evicted covers appear as placeholders.</p>
    {confirming && <div className="journal-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="journal-clear-heading"
      className="journal-confirm" data-navigation-dialog onKeyDown={(event) => {
        if (event.key === "Escape" && !command.pending) { event.stopPropagation(); closeConfirmation(); }
        if (event.key === "Tab") {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first = buttons[0], last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <h3 id="journal-clear-heading">Clear all journal identifications?</h3>
      <p>This permanently clears source and display history and unused journal covers.
        It does not clear the last album or remembered edition corrections. The source must be reachable.</p>
      <button ref={cancel} data-navigation-cancel disabled={command.pending} onClick={closeConfirmation}>Cancel</button>
      <button disabled={command.pending} onClick={() => { void erase(); }}>Confirm clear journal</button>
    </div></div>}
  </section>;
}

function JournalCover({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return url && !failed ? <img src={url} alt={`Cover for ${title}`} loading="lazy" onError={() => setFailed(true)} />
    : <span className="journal-cover-missing">Cover unavailable</span>;
}
