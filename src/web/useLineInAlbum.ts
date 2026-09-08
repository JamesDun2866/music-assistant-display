import { useCallback, useEffect, useRef, useState } from "react";
import { albumViewSchema, type AlbumView } from "../shared/line-in-album.js";
export type { AlbumView } from "../shared/line-in-album.js";

/** Shared by the independent album and vinyl surfaces; cached content outlives live status. */
export function useLineInAlbum(): { view: AlbumView | null; refresh: () => void } {
  const [view, setView] = useState<AlbumView | null>(null);
  const [revision, setRevision] = useState(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => () => clearTimeout(expiry.current), []);
  useEffect(() => {
    let alive = true;
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
        clearTimeout(expiry.current);
        if (result.expiresAt <= Date.now()) {
          setView({ ...result, state: "offline", retry: null });
        } else {
          setView(result);
          expiry.current = setTimeout(() => setView((previous) => previous
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
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [revision]);
  return { view, refresh };
}
