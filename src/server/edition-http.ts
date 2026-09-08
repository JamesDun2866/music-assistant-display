import type { Express, Request, Response } from "express";
import { z } from "zod";
import { editionSearchInputSchema, editionPreviewInputSchema, editionConfirmInputSchema, editionRemoveInputSchema,
  editionMetadataRetrySchema } from "../shared/album-editions.js";
import { AlbumEditions, EditionError } from "./album-editions.js";
import { ProviderError } from "./album-provider-network.js";

export type EditionHttpService = Pick<AlbumEditions, "search" | "preview" | "confirm" | "remove" | "artwork">
  & Partial<Pick<AlbumEditions, "retryMetadata">>;
const session = (req: Request) => /(?:^|;\s*)karaoke_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1] ?? "";

export function editionRoutes(app: Express, editions?: EditionHttpService) {
  const post = <T>(route: string, schema: z.ZodType<T>,
    operation: (value: T, session: string, signal: AbortSignal) => Promise<unknown>) => {
    app.post(`/api/line-in-album/edition/${route}`, async (req: Request, res: Response) => {
      if (!editions) { res.status(503).json({ error: "Edition correction is not configured." }); return; }
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Provide a valid album-bound edition request." }); return; }
      const controller = new AbortController();
      const closed = () => controller.abort();
      res.once("close", closed);
      try { res.json(await operation(parsed.data, session(req), AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]))); }
      catch (error) {
        if (error instanceof EditionError) throw error;
        if (error instanceof ProviderError) throw new EditionError(
          error.code === "busy" || error.code === "rate-limited" ? 429 : 502,
          error.code === "rate-limited" ? "Catalog provider is cooling down. Wait before retrying album metadata."
            : "Catalog request unavailable or incomplete. Saved album data is unchanged.");
        throw new EditionError(route === "search" || route === "preview" ? 502 : 503,
          route === "search" || route === "preview" ? "Catalog request unavailable or incomplete. Try again explicitly."
            : "Edition could not be saved; refresh the album before trying again.");
      } finally { res.off("close", closed); }
    });
  };
  post("search", editionSearchInputSchema, (value, owner, signal) => editions!.search(value, owner, signal));
  post("preview", editionPreviewInputSchema, (value, owner, signal) => editions!.preview(value, owner, signal));
  post("confirm", editionConfirmInputSchema, (value, owner) => editions!.confirm(value, owner));
  post("remove", editionRemoveInputSchema, (value, owner) => editions!.remove(value, owner));
  post("retry-metadata", editionMetadataRetrySchema, (value, owner, signal) => {
    if (!editions?.retryMetadata) throw new EditionError(503, "Catalog fallback is not configured.");
    return editions.retryMetadata(value, owner, signal);
  });
  app.get("/api/line-in-album/edition/artwork/:token", async (req, res) => {
    if (!editions || !/^[a-f0-9]{64}$/.test(req.params.token)) { res.sendStatus(404); return; }
    const owner = session(req);
    if (!owner) { res.status(403).json({ error: "A local session is required." }); return; }
    const controller = new AbortController();
    const closed = () => controller.abort();
    res.once("close", closed);
    try {
      const artwork = await editions.artwork(req.params.token, owner, AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]));
      if (!artwork) { res.sendStatus(404); return; }
      res.type(artwork.contentType).send(artwork.bytes);
    } finally { res.off("close", closed); }
  });
}
