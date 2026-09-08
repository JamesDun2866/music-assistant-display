import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  albumPreviewSchema, completedRecordingSchema, recordingLabelSchema, recordingPageSchema,
  type AlbumPreview, type CompletedRecording,
} from "../shared/source-tools.js";
import { focusNavigation } from "./navigation.js";
import { useLocalCommand } from "./useLocalCommand.js";
import "./source-tools.css";

function RecordingRow({ recording, update }: {
  recording: CompletedRecording; update: (recording: CompletedRecording) => void;
}) {
  const command = useLocalCommand();
  const [label, setLabel] = useState(recording.label);
  const [preview, setPreview] = useState<AlbumPreview | null>(null);
  const [previewExpired, setPreviewExpired] = useState(false);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const previewCancel = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const path = `/api/source-tools/recordings/${encodeURIComponent(recording.id)}`;
  const acceptRecording = (data: unknown) => {
    const parsed = completedRecordingSchema.safeParse(data);
    if (!parsed.success || parsed.data.id !== recording.id) throw new Error("The local service returned an invalid recording.");
    update(parsed.data);
  };
  useEffect(() => {
    setLabel(recording.label);
    setPreview(null);
  }, [recording.revision, recording.label]);
  useEffect(() => {
    if (!preview) return;
    focusNavigation(previewCancel.current);
    const timer = setTimeout(() => {
      setPreview(null);
      setPreviewExpired(true);
      focusNavigation(previewTrigger.current);
    }, Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  const cancelPreview = () => {
    setPreview(null);
    focusNavigation(previewTrigger.current);
  };
  return <article className="source-recording" aria-label={recording.label}>
    <h3>{recording.label}</h3>
    <p>{recording.format.toUpperCase()} · {(recording.bytes / 1024 / 1024).toFixed(1)} MiB · Completed{" "}
      <time dateTime={recording.completedAt}>{new Date(recording.completedAt).toLocaleString()}</time></p>
    {recording.album && <p>Attached album metadata: {recording.album.title} — {recording.album.artist}</p>}
    <form onSubmit={(event) => {
      event.preventDefault();
      const parsed = recordingLabelSchema.safeParse(label);
      if (!parsed.success || command.pending) return;
      setPreview(null);
      void command.execute(`${path}/label`, { revision: recording.revision, label: parsed.data },
        "Recording label saved. Original audio is unchanged.", { accept: acceptRecording });
    }}>
      <label htmlFor={labelId}>Display and download label</label>
      <input id={labelId} value={label} maxLength={120} disabled={command.pending}
        onChange={(event) => setLabel(event.target.value)} aria-describedby={`${labelId}-help`} />
      <p id={`${labelId}-help`}>Changes display and download name; original audio is unchanged. Use 1–120 printable characters, without path characters.</p>
      <button type="submit" disabled={command.pending || !recordingLabelSchema.safeParse(label).success || label === recording.label}>Save label</button>
    </form>
    <div className="source-recording-actions">
      <button type="button" disabled={command.pending} onClick={() => {
        void command.execute(`${path}/download`, { revision: recording.revision }, "Download requested.", {
          accept: (data) => {
            if (!data || typeof data !== "object" || !("url" in data) || typeof data.url !== "string"
              || !/^\/api\/source-tools\/downloads\/[A-Za-z0-9_-]+$/.test(data.url)) {
              throw new Error("The local service returned an invalid download link.");
            }
            const link = document.createElement("a");
            link.href = data.url;
            link.download = "";
            document.body.append(link);
            link.click();
            link.remove();
          },
        });
      }}>Download original audio</button>
      <button ref={previewTrigger} type="button" disabled={command.pending} onClick={() => {
        setPreview(null);
        setPreviewExpired(false);
        void command.execute(`${path}/album-preview`, { revision: recording.revision }, "Review the album before attaching.", {
          accept: (data) => {
            const parsed = albumPreviewSchema.safeParse(data);
            if (!parsed.success) throw new Error("The local service returned an invalid album preview.");
            const value = parsed.data;
            if (value.expiresAt <= Date.now()) throw new Error("Album preview expired. Request another preview.");
            setPreview(value);
          },
        });
      }}>Preview album attachment</button>
    </div>
    {preview && <section className="source-recording-preview" aria-label="Confirm album attachment">
      <h3>Attach this album metadata?</h3>
      <p>{preview.album.title} — {preview.album.artist}</p>
      <p>Catalog: {preview.album.catalog
        ? `${preview.album.catalog.kind} ${preview.album.catalog.id} (${preview.album.catalog.country.toUpperCase()})`
        : "Unknown"} · Provenance: {preview.album.provenance.kind}</p>
      <p>This metadata is not proof of the recording contents. Only this confirmed, source-matched album is attached.
        Original audio and its embedded tags are unchanged.</p>
      <button type="button" disabled={command.pending} onClick={() => {
        const confirmationToken = preview.confirmationToken;
        if (preview.expiresAt <= Date.now()) {
          setPreviewExpired(true);
          cancelPreview();
          return;
        }
        setPreview(null);
        focusNavigation(previewTrigger.current);
        void command.execute(`${path}/album`, { revision: recording.revision, confirmationToken },
          "Album metadata attached. Original audio is unchanged.", { accept: acceptRecording });
      }}>Confirm album attachment</button>
      <button ref={previewCancel} type="button" onClick={cancelPreview}>Cancel attachment</button>
    </section>}
    {previewExpired && <p role="status">Album preview expired. Request another preview.</p>}
    {command.error && <p role="alert">{command.error} Refresh recordings if the file or metadata changed.</p>}
    <p role="status">{command.pending ? "Contacting local service…" : command.notice}</p>
  </article>;
}

export function RecordingLibrary(): React.JSX.Element {
  const [items, setItems] = useState<CompletedRecording[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(async (next: string | null = null) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    setLoading(true);
    setError(null);
    if (!next) {
      setItems([]);
      setCursor(null);
      setLoaded(false);
      setGeneration((value) => value + 1);
    }
    try {
      const response = await fetch(`/api/source-tools/recordings?limit=50${next ? `&cursor=${encodeURIComponent(next)}` : ""}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const code = data && typeof data === "object" && "error" in data ? data.error : null;
        throw new Error(code === "restart-needed"
          ? "The recording list changed or expired. Refresh recordings to restart."
          : code === "not-configured" ? "The optional source is not configured."
            : code === "offline" ? "The source is offline. Completed recordings will be available when it reconnects."
              : "Completed recordings are unavailable. Refresh recordings to retry.");
      }
      const page = recordingPageSchema.parse(data);
      if (controller.signal.aborted || request.current !== controller) return;
      setItems((before) => {
        const combined = new Map((next ? before : []).map((item) => [item.id, item]));
        for (const item of page.items) combined.set(item.id, item);
        return [...combined.values()];
      });
      setCursor(page.nextCursor);
      setLoaded(true);
    } catch (failure) {
      if (request.current !== controller) return;
      setError(controller.signal.aborted ? "Recording list request timed out. Refresh recordings to retry."
        : failure instanceof Error && !(failure instanceof SyntaxError) && failure.name !== "ZodError"
          ? failure.message : "The local service returned an invalid recording list.");
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { request.current?.abort(); request.current = null; };
  }, [load]);
  return <section aria-label="Completed recordings">
    <h2>Completed recordings</h2>
    <p>Finalized recordings only. These tools cannot start, rearm, stop or delete recordings.</p>
    <button type="button" disabled={loading} onClick={() => void load()}>Refresh recordings</button>
    {loading && <p role="status">Loading completed recordings…</p>}
    {error && <p role="alert">{error}</p>}
    {loaded && !loading && !items.length && !cursor && <p>No completed recordings found.</p>}
    {loaded && !items.length && cursor && <p>No completed recordings in this scan page. Continue scanning.</p>}
    {items.map((recording) => <RecordingRow key={`${generation}:${recording.id}`}
      recording={recording} update={(updated) => {
        setItems((before) => before.map((item) => item.id === updated.id ? updated : item));
      }} />)}
    {cursor && <button type="button" disabled={loading} onClick={() => void load(cursor)}>Load more recordings</button>}
  </section>;
}
