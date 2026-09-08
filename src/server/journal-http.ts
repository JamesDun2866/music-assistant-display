import { once } from "node:events";
import type { Express } from "express";
import { z } from "zod";
import { journalClearSchema } from "../shared/listening-journal.js";
import type { ListeningJournal } from "./listening-journal.js";

const querySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.string().regex(/^(?:[1-9][0-9]?|100)$/).transform(Number).optional(),
}).strict();

/** Mount after the existing local-only, CSRF and bounded JSON middleware. */
export type JournalHttpService = Pick<ListeningJournal, "page" | "artwork" | "clear" | "export">;
export function journalRoutes(app: Express, journal?: JournalHttpService) {
  app.get("/api/listening-journal", async (req, res) => {
    if (!journal) { res.status(503).json({ error: "Journal is not configured." }); return; }
    const query = querySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid journal page request." }); return; }
    res.json(await journal.page(query.data.cursor, query.data.limit));
  });
  app.post("/api/listening-journal/clear", async (req, res) => {
    if (!journal) { res.status(503).json({ error: "Journal is not configured." }); return; }
    const body = journalClearSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Confirm clearing the current journal." }); return; }
    await journal.clear(body.data.revision);
    res.json({ ok: true });
  });
  app.get("/api/listening-journal/artwork/:asset", async (req, res) => {
    if (!journal) { res.sendStatus(404); return; }
    const image = await journal.artwork(req.params.asset);
    if (!image) { res.sendStatus(404); return; }
    res.type("image/jpeg").send(image);
  });
  app.get("/api/listening-journal/export", async (_req, res) => {
    if (!journal) { res.status(503).json({ error: "Journal is not configured." }); return; }
    const controller = new AbortController();
    const closed = () => controller.abort();
    res.once("close", closed);
    const stream = journal.export(controller.signal);
    try {
      const first = await stream.next();
      res.set({ "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="listening-journal.json"' });
      if (!first.done && !res.write(first.value)) await once(res, "drain", { signal: controller.signal });
      for await (const chunk of stream) {
        if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
      }
      res.end();
    } catch (error) {
      if (res.headersSent) res.destroy();
      else throw error;
    } finally { controller.abort(); res.off("close", closed); await stream.return(undefined); }
  });
}
