import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_BACKGROUNDS, type AmbientImage, type AmbientLibrary, type AmbientSettings } from "../shared/ambient.js";
import { ambientImageSchema, ambientLibrarySchema } from "./schema.js";
import type { LocalCommand } from "./useLocalCommand.js";
import { focusCurrentView, focusNavigation, useNavigationAdjustment } from "./navigation.js";

export const AMBIENT_IDLE_MS = 8_000;
export const AMBIENT_CROSSFADE_MS = 1_200;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const fallbackImage = BUILTIN_BACKGROUNDS[0]!;

function focusAmbientControl() {
  const root = document.querySelector<HTMLElement>(".display");
  if (root) focusCurrentView(root);
}

export function useAmbientControls(active: boolean, blocked: boolean) {
  const [visible, setVisible] = useState(true);
  const lastInteraction = useRef(0);
  const focusRequested = useRef(false);
  const reveal = useCallback((focus = false) => {
    lastInteraction.current = performance.now();
    focusRequested.current ||= focus;
    setVisible(true);
    if (focus && document.querySelector(".display-header:not([hidden])")) {
      focusRequested.current = false;
      focusAmbientControl();
    }
  }, []);
  const hide = useCallback(() => setVisible(false), []);

  useEffect(() => {
    if (visible && focusRequested.current) {
      focusRequested.current = false;
      focusAmbientControl();
    }
  });
  useEffect(() => {
    reveal();
    if (!active) return;
    const activity = () => reveal();
    for (const type of ["pointermove", "pointerdown", "touchstart", "focusin"]) {
      window.addEventListener(type, activity, { passive: true });
    }
    const timer = setInterval(() => {
      const focus = document.activeElement;
      const focusedControl = focus instanceof HTMLElement
        && Boolean(focus.closest(".display-header, .display-footer"));
      if (blocked || focusedControl) {
        lastInteraction.current = performance.now();
      } else if (performance.now() - lastInteraction.current >= AMBIENT_IDLE_MS) {
        setVisible(false);
      }
    }, 250);
    return () => {
      clearInterval(timer);
      for (const type of ["pointermove", "pointerdown", "touchstart", "focusin"]) {
        window.removeEventListener(type, activity);
      }
    };
  }, [active, blocked, reveal]);
  return { visible, reveal, hide };
}

export function useAmbientLibrary(active: boolean, open: boolean) {
  const [images, setImages] = useState<AmbientImage[]>(BUILTIN_BACKGROUNDS);
  const [limits, setLimits] = useState<AmbientLibrary["limits"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sceneIssue, setSceneIssue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    setLoading(true);
    try {
      const response = await fetch("/api/backgrounds", {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Scene library could not refresh (${response.status}).`);
      const parsed = ambientLibrarySchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("The local service returned an invalid scene library.");
      if (!mounted.current || request.current !== controller) return;
      setImages(parsed.data.images);
      setLimits(parsed.data.limits);
      setError(null);
    } catch (failure) {
      if (!mounted.current || request.current !== controller) return;
      setError(`${controller.signal.aborted ? "Scene library refresh timed out." : failure instanceof Error
        ? failure.message : "Scene library could not be reached."} Keeping known scenes. Open the library to retry.`);
    } finally {
      clearTimeout(timeout);
      if (mounted.current && request.current === controller) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => {
      clearInterval(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [active, open, refresh]);
  const add = useCallback((image: AmbientImage) => {
    setImages((known) => known.some((item) => item.id === image.id)
      ? known.map((item) => item.id === image.id ? image : item) : [...known, image]);
    void refresh();
  }, [refresh]);
  const remove = useCallback((ids: string[]) => {
    setImages((known) => known.filter((image) => image.source !== "upload" || !ids.includes(image.id)));
    void refresh();
  }, [refresh]);
  return { images, limits, error, sceneIssue, setSceneIssue, loading, refresh, add, remove };
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const changed = () => setReduced(query.matches);
    changed();
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
  return reduced;
}

function SceneFrame({ image, reduced, onError, availableIds }: {
  image: AmbientImage; reduced: boolean; onError: (id: string) => void; availableIds: string[];
}) {
  const [frame, setFrame] = useState<{ current: AmbientImage; previous: AmbientImage | null; loaded: boolean }>({
    current: image, previous: null, loaded: false,
  });
  useEffect(() => {
    setFrame((before) => {
      if (before.current.id === image.id && before.current.url === image.url) return before;
      const previous = reduced ? null : before.loaded ? before.current : before.previous ?? before.current;
      return {
        current: image, loaded: false,
        previous: previous?.id === image.id && previous.url === image.url ? null : previous,
      };
    });
  }, [image.id, image.url, reduced]);
  useEffect(() => {
    if (!frame.previous) return;
    if (reduced) { setFrame((before) => ({ ...before, previous: null })); return; }
    if (!frame.loaded) return;
    const timer = setTimeout(() => setFrame((before) => ({ ...before, previous: null })), AMBIENT_CROSSFADE_MS);
    return () => clearTimeout(timer);
  }, [frame.current.id, frame.loaded, Boolean(frame.previous), reduced]);
  return <div className={`ambient-scene${reduced ? " reduced-motion" : ""}`} data-scene-id={frame.current.id}>
    {frame.previous && availableIds.includes(frame.previous.id) && <img key={`${frame.previous.id}:${frame.previous.url}`} className="ambient-slide ambient-slide-previous"
      src={frame.previous.url} alt="" aria-hidden="true" />}
    {availableIds.includes(frame.current.id) && <img key={`${frame.current.id}:${frame.current.url}`} className={`ambient-slide ambient-slide-current${!frame.previous || frame.loaded ? " is-ready" : ""}`}
      src={frame.current.url} alt={frame.current.title} decoding="async"
      onLoad={() => setFrame((before) => ({ ...before, loaded: true }))}
      onError={() => onError(frame.current.id)} />}
  </div>;
}

export function AmbientScene({ settings, images, onIssue }: {
  settings: AmbientSettings; images: AmbientImage[]; onIssue: (message: string | null) => void;
}) {
  const reduced = useReducedMotion();
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const selectionKey = JSON.stringify(settings.selectedIds);
  const imageKey = JSON.stringify(images);
  const availableIds = [...images.map((image) => image.id), fallbackImage.id];
  const availabilityKey = JSON.stringify(availableIds);
  useEffect(() => setFailedIds([]), [availabilityKey]);
  // Snapshot objects are replaced frequently; the playlist clock only follows actual scene changes.
  const selected = useMemo(() => settings.selectedIds.flatMap((id) => {
    const image = images.find((item) => item.id === id);
    return image && !failedIds.includes(id) ? [image] : [];
  }), [selectionKey, imageKey, failedIds]);
  const playlist = selected.length ? selected : failedIds.includes(fallbackImage.id) ? [] : [fallbackImage];
  const playlistKey = JSON.stringify(playlist.map((image) => image.id));
  const [currentId, setCurrentId] = useState<string | null>(playlist[0]?.id ?? null);
  const current = settings.slideshow ? playlist.find((image) => image.id === currentId) ?? playlist[0] : playlist[0];
  const dwell = Math.max(15, Math.min(3600, settings.dwellSeconds));
  useEffect(() => setCurrentId(current?.id ?? null), [current?.id]);
  useEffect(() => {
    if (!current || !settings.slideshow || playlist.length < 2) return;
    const timer = setTimeout(() => {
      const index = playlist.findIndex((image) => image.id === current.id);
      setCurrentId(playlist[(index + 1) % playlist.length]!.id);
    }, dwell * 1000);
    return () => clearTimeout(timer);
  }, [settings.slideshow, dwell, playlistKey, current?.id]);
  useEffect(() => {
    onIssue(failedIds.length
      ? selected.length ? "A photo could not load and has been skipped. Other selected images will continue."
        : failedIds.includes(fallbackImage.id) ? "Photos could not load. Open Scene library to choose another image."
          : `Selected photos could not load. Showing ${fallbackImage.title} as a fallback.`
      : null);
    return () => onIssue(null);
  }, [failedIds.length, selected.length, onIssue]);
  if (!current) {
    return <div className="ambient-scene ambient-empty" data-scene-id="">
      <div><h1>A quiet space</h1><p>Photos could not load. Open Scene library to choose another image.</p></div>
    </div>;
  }
  return <SceneFrame image={current} reduced={reduced} availableIds={availableIds} onError={(id) => {
    setFailedIds((before) => before.includes(id) ? before : [...before, id]);
  }} />;
}

function sizeLabel(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`;
}

function ScenePreview({ image, disabled }: { image: AmbientImage; disabled: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [image.thumbnailUrl]);
  if (!image.thumbnailUrl || failed) {
    return <div className="ambient-preview-unavailable">
      <p>Preview unavailable. {failed ? "Retry or refresh the library." : "Refresh the library after updating the service."}</p>
      {failed && <button type="button" disabled={disabled} aria-label={`Retry preview for ${image.title}`}
        onClick={() => setFailed(false)}>Retry preview</button>}
    </div>;
  }
  return <img src={image.thumbnailUrl} alt="" loading="lazy" decoding="async" width={480} height={270}
    onError={() => setFailed(true)} />;
}

export function AmbientLibraryControls({ settings, library, command, disabled, kiosk = false }: {
  settings: AmbientSettings;
  library: ReturnType<typeof useAmbientLibrary>;
  command: LocalCommand;
  disabled: boolean;
  kiosk?: boolean;
}) {
  const [draft, setDraft] = useState<Partial<AmbientSettings>>({});
  const [dwellInput, setDwellInput] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<AmbientImage[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const deleteWasOpen = useRef(false);
  const selectedIds = draft.selectedIds ?? settings.selectedIds;
  const slideshow = draft.slideshow ?? settings.slideshow;
  const dwellText = dwellInput ?? String(settings.dwellSeconds);
  const dwellValid = /^\d+$/.test(dwellText) && Number(dwellText) >= 15 && Number(dwellText) <= 3600;
  const dirty = Object.keys(draft).length > 0 || dwellInput !== null;
  const uploads = library.images.filter((image) => image.source === "upload");
  const deletable = uploads.filter((image) => deleteIds.includes(image.id));
  const unavailableCount = selectedIds.filter((id) => !library.images.some((image) => image.id === id)).length;
  const dwellAdjustment = useNavigationAdjustment((direction) => {
    if (disabled) return;
    const value = Number(dwellText);
    setSaved(false);
    setDwellInput(String(Math.max(15, Math.min(3600, (Number.isFinite(value) ? value : 60) + direction))));
  });

  useEffect(() => {
    if (confirmation) focusNavigation(deleteCancel.current);
    else if (deleteWasOpen.current) focusNavigation(deleteTrigger.current);
    deleteWasOpen.current = confirmation !== null;
  }, [confirmation]);

  useEffect(() => {
    if (!saved) return;
    const matches = (draft.selectedIds === undefined || JSON.stringify(draft.selectedIds) === JSON.stringify(settings.selectedIds))
      && (draft.slideshow === undefined || draft.slideshow === settings.slideshow)
      && (dwellInput === null || Number(dwellInput) === settings.dwellSeconds);
    if (matches) {
      setDraft({});
      setDwellInput(null);
      setSaved(false);
    }
  }, [settings, draft, dwellInput, saved]);

  const edit = (patch: Partial<AmbientSettings>) => {
    setSaved(false);
    setDraft((before) => ({ ...before, ...patch }));
  };
  const save = async () => {
    if (!dwellValid) return;
    const patch = { ...draft, ...(dwellInput === null ? {} : { dwellSeconds: Number(dwellInput) }) };
    if (await command.execute("/api/settings", { ambient: patch }, "Ambient settings saved.")) setSaved(true);
  };
  const showOnly = async (id: string) => {
    if (await command.execute("/api/settings", { ambient: { selectedIds: [id], slideshow: false } }, "Static scene saved.")) {
      setDraft((before) => ({ ...before, selectedIds: [id], slideshow: false }));
      setSaved(true);
    }
  };
  const upload = async (file: File) => {
    setUploadError(null);
    setRetryFile(null);
    const maxBytes = Math.min(MAX_UPLOAD_BYTES, library.limits?.maxUploadBytes ?? MAX_UPLOAD_BYTES);
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setUploadError("Choose a JPEG or PNG image. Other formats are not supported.");
      return;
    }
    if (file.size > maxBytes || file.size === 0) {
      setUploadError(`Choose a nonempty image no larger than ${sizeLabel(maxBytes)}.`);
      return;
    }
    const ok = await command.execute("/api/backgrounds/upload", file, "Image uploaded. Include it in your selection, or choose Show only.", {
      raw: true,
      headers: { "Content-Type": file.type, "X-Image-Title": encodeURIComponent(file.name) },
      accept: (data) => {
        const image = ambientImageSchema.safeParse(data && typeof data === "object" && "image" in data ? data.image : null);
        if (!image.success || image.data.source !== "upload") throw new Error("The upload response was invalid. Refresh the library before trying again.");
        library.add(image.data);
      },
    });
    if (ok && fileInput.current) fileInput.current.value = "";
    if (!ok) setRetryFile(file);
  };
  const deleteImages = async () => {
    if (!confirmation) return;
    const ids = confirmation.map((image) => image.id);
    const ok = await command.execute("/api/backgrounds/delete", { ids }, "Selected uploaded images deleted.", {
      accept: (data) => {
        if (!data || typeof data !== "object" || !("deletedIds" in data) || !Array.isArray(data.deletedIds)
          || data.deletedIds.length !== ids.length
          || !ids.every((id) => (data.deletedIds as unknown[]).includes(id))) {
          throw new Error("The deletion response was invalid. Refresh the library to check the images.");
        }
        library.remove(data.deletedIds as string[]);
      },
    });
    if (ok) { setDeleteIds([]); setConfirmation(null); }
  };

  return <section className="ambient-library-panel" aria-labelledby="scene-library-heading" tabIndex={0} data-navigation-scroll>
    <div className="ambient-library-heading">
      <div><h1 id="scene-library-heading">Choose your scene</h1>
        <p>Photography for your room. Just a view, never a change to your music.</p></div>
      <button onClick={() => void library.refresh()} disabled={library.loading}>
        {library.loading ? "Refreshing…" : "Refresh library"}
      </button>
    </div>
    <details className="ambient-collection-intro">
      <summary>About the photo collection · Included offline</summary>
      <h2>Native 4K photo collection</h2>
      <p>{BUILTIN_BACKGROUNDS.length} individually rights-cleared photos by Romain Guy at 3840x2160, including the original four Chromecast archive photos and more from his portfolio. The full 702-photo archive is not licensed as one collection.</p>
      <p>All {BUILTIN_BACKGROUNDS.length} photos are included with this display and work offline. The library uses small local previews. Viewing them makes no external image requests.
        Photo-source and license links open external sites only when you choose to visit them.</p>
      {kiosk && <p>Use a keyboard or admin browser to open photo-source and license links. TV remote navigation stays in this display.</p>}
    </details>
    <form className="ambient-preferences" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="ambient-preference-fields">
        <label className="ambient-checkbox"><input type="checkbox" checked={slideshow} disabled={disabled}
          onChange={(event) => edit({ slideshow: event.target.checked })} /> Slideshow</label>
        <label className="ambient-dwell">Seconds per scene
          <input ref={dwellAdjustment} type="number" min="15" max="3600" step="1" inputMode="numeric" value={dwellText}
            disabled={disabled} aria-invalid={!dwellValid} aria-describedby="ambient-dwell-help"
            onChange={(event) => { setSaved(false); setDwellInput(event.target.value); }} />
        </label>
        <button type="submit" className="ambient-save" disabled={disabled || !dirty || !dwellValid}>
          {command.pending ? "Saving…" : "Save selection"}
        </button>
        {dirty && <button type="button" disabled={disabled} onClick={() => {
          setDraft({}); setDwellInput(null); setSaved(false);
        }}>Discard edits</button>}
      </div>
      <p id="ambient-dwell-help">15–3,600 seconds. {slideshow ? "Scenes follow your selection order." : "Static mode shows the first selected scene."}
        {dirty && !saved ? " You have unsaved changes." : ""}</p>
      {!dwellValid && <p role="alert">Enter a whole number from 15 to 3,600 seconds.</p>}
      <div className="ambient-collection-actions" aria-label="Select a collection">
        <span>Select</span>
        <button type="button" disabled={disabled} onClick={() => edit({
          selectedIds: library.images.filter((image) => image.source === "builtin").map((image) => image.id),
        })}>Collection photos</button>
        <button type="button" disabled={disabled} onClick={() => edit({ selectedIds: uploads.map((image) => image.id) })}>Uploads</button>
        <button type="button" disabled={disabled} onClick={() => edit({ selectedIds: library.images.map((image) => image.id) })}>All scenes</button>
        <button type="button" disabled={disabled} onClick={() => edit({ selectedIds: [] })}>Clear selection</button>
      </div>
      <p className="ambient-selection-note">{selectedIds.length} selected · {selectedIds.length - unavailableCount} available on this service.
        {!selectedIds.length || unavailableCount === selectedIds.length ? ` With no available selection, ${fallbackImage.title} is shown as a fallback.` : ""}
        {unavailableCount > 0 ? ` ${unavailableCount} unavailable; these will be skipped.` : ""}</p>
      <ul className="ambient-image-grid">
        {library.images.map((image) => <li key={image.id} className={selectedIds.includes(image.id) ? "scene-included" : ""}>
          <ScenePreview image={image} disabled={disabled} />
          <div className="ambient-image-caption">
            <label className="ambient-checkbox"><input type="checkbox" checked={selectedIds.includes(image.id)}
              disabled={disabled} onChange={(event) => edit({ selectedIds: event.target.checked
                ? [...selectedIds, image.id] : selectedIds.filter((id) => id !== image.id) })} />
              <span>{image.title}</span></label>
            <span className="ambient-image-source">{image.source === "builtin" ? "Included photo · Offline" : "Your upload"}</span>
            <button type="button" disabled={disabled} onClick={() => void showOnly(image.id)}
              aria-label={`Show only ${image.title}`}>Show only</button>
            {image.source === "builtin" && <>
              {image.credit && <p className="ambient-photo-credit">{image.credit.author} ·{" "}
                <a href={image.credit.sourceUrl} aria-label={`View ${image.title} on Flickr (opens a new tab)`}
                  target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Photo source</a> ·{" "}
                <a href={image.credit.licenseUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{image.credit.license}</a></p>}
            </>}
            {image.source === "upload" && <label className="ambient-checkbox ambient-delete-choice">
              <input type="checkbox" checked={deleteIds.includes(image.id)} disabled={disabled || confirmation !== null}
                onChange={(event) => setDeleteIds((before) => event.target.checked
                  ? [...before, image.id] : before.filter((id) => id !== image.id))} />
              <span>Delete <span className="sr-only">{image.title}</span></span>
            </label>}
          </div>
        </li>)}
      </ul>
    </form>
    <section className="ambient-upload" aria-labelledby="upload-heading">
      <h2 id="upload-heading">Bring your own view</h2>
      <p>JPEG or PNG · up to {sizeLabel(Math.min(MAX_UPLOAD_BYTES, library.limits?.maxUploadBytes ?? MAX_UPLOAD_BYTES))} per image.
        {library.limits ? ` Up to ${Math.round(library.limits.maxPixels / 1_000_000)} megapixels. ${uploads.length} of ${library.limits.maxImages} uploads · ${sizeLabel(uploads.reduce((sum, image) => sum + image.bytes + (image.thumbnailBytes ?? 0), 0))} of ${sizeLabel(library.limits.maxStorageBytes)} used.`
          : "Upload count, storage, and pixel limits will appear when the library connects."}</p>
      {kiosk ? <p>Use admin browser to choose files. The TV remote cannot open or control a file picker.</p> : <label className="ambient-file-label">Upload an image
        <input ref={fileInput} type="file" accept="image/jpeg,image/png" disabled={disabled}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      </label>}
      {uploadError && <p role="alert">{uploadError}</p>}
      {retryFile && <button disabled={disabled} onClick={() => void upload(retryFile)}>Retry upload</button>}
      <p>Your files stay on this local service. Uploading does not change the active scene.</p>
    </section>
    {uploads.length > 0 && <section className="ambient-delete" aria-labelledby="delete-heading">
      <h2 id="delete-heading">Manage uploads</h2>
      <p>Mark uploaded images for deletion above. Collection photos are never deleted here.</p>
      {confirmation ? <div className="ambient-delete-confirmation" data-navigation-dialog>
        <p>Delete {confirmation.length} uploaded image{confirmation.length === 1 ? "" : "s"} from this service? This cannot be undone.</p>
        <ul>{confirmation.map((image) => <li key={image.id}>{image.title}</li>)}</ul>
        <div><button disabled={disabled} onClick={() => void deleteImages()}>Confirm delete</button>
          <button ref={deleteCancel} data-navigation-cancel disabled={command.pending} onClick={() => setConfirmation(null)}>Cancel deletion</button></div>
      </div> : <button ref={deleteTrigger} disabled={disabled || !deletable.length} onClick={() => setConfirmation(deletable)}>
        Delete {deletable.length || "selected"} upload{deletable.length === 1 ? "" : "s"}…
      </button>}
    </section>}
    <div className="ambient-library-feedback">
      {command.pending && <p role="status">Sending to local service…</p>}
      {command.error && <p role="alert">{command.error}</p>}
      {command.notice && <p role="status">{command.notice}</p>}
      {library.error && <p role="alert">{library.error}</p>}
    </div>
  </section>;
}
