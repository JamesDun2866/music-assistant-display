import type { Request, Response } from "express";
import { kioskReportSchema, type KioskPage } from "../shared/kiosk-diagnostics.js";

/** Short-lived self-reports, not proof of compositor focus or cursor visibility. */
export class KioskDiagnostics {
  private readonly pages = new Map<string, { session: string; at: number; page: KioskPage }>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  private prune() {
    for (const [id, report] of this.pages) {
      if (this.now() - report.at >= 45_000) this.pages.delete(id);
    }
  }

  report = (req: Request, res: Response): void => {
    const parsed = kioskReportSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.page.queryEnabled) {
      res.status(400).json({ error: "A bounded explicit-kiosk page report is required" }); return;
    }
    const session = /(?:^|;\s*)karaoke_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
    if (!session) { res.status(403).json({ error: "A local session is required" }); return; }
    this.prune();
    const { pageId, page } = parsed.data;
    const previous = this.pages.get(pageId);
    if (previous && previous.session !== session) {
      res.status(409).json({ error: "Page report belongs to another session" }); return;
    }
    if (!previous && this.pages.size >= 4) {
      res.status(429).json({ error: "Too many reporting kiosk pages; close duplicates and wait 45 seconds" }); return;
    }
    if (previous && this.now() - previous.at < 1_000) {
      res.status(429).json({ error: "Wait before reporting this page again" }); return;
    }
    this.pages.set(pageId, { session, at: this.now(), page });
    res.json({ ok: true });
  };

  read = (req: Request, res: Response): void => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) {
      res.status(400).json({ error: "Provide an empty JSON object" }); return;
    }
    this.prune();
    res.json({ pages: [...this.pages.values()].map(({ at, page }) => ({
      ageMs: Math.max(0, Math.floor(this.now() - at)), page,
    })) });
  };
}
