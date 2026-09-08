// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AlbumEditionCorrection } from "../src/web/AlbumEditionCorrection.js";
const binding = { sourceId: "a".repeat(64), albumKey: `${"b".repeat(32)}-1`, success: null, revision: 0 };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("searches only on explicit submit and previews before explicit confirmation with local CSRF", async () => {
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url === "/api/session") return { ok: true, json: async () => ({ csrfToken: "local-token" }) };
    expect(init?.headers).toMatchObject({ "X-CSRF-Token": "local-token" });
    const data = url.endsWith("/search") ? { searchToken: "c".repeat(64),
      results: [{ collectionId: "123", country: "gb", title: "Selected", artist: "Artist" }] }
      : url.endsWith("/preview") ? { previewToken: "d".repeat(64), title: "Selected", artist: "Artist",
        country: "gb", collectionId: "123", artworkUrl: `/api/line-in-album/edition/artwork/${"d".repeat(64)}`,
        artworkUnavailable: false, scope: "current-album",
        tracklist: { status: "complete", message: null, title: "Selected", artist: "Artist", discCount: 1,
          tracks: [{ disc: 1, number: 1, title: "Full track" }] } }
        : { binding: { ...binding, revision: 1 }, corrected: true, scope: "current-album" };
    return { ok: true, json: async () => data };
  });
  vi.stubGlobal("fetch", fetcher);
  const changed = vi.fn();
  render(<AlbumEditionCorrection binding={binding} original={{ title: "Original", artist: "Artist" }}
    corrected={false} onChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  fireEvent.change(screen.getByLabelText("Artist"), { target: { value: "Edited artist" } });
  expect(fetcher).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Search Apple" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/storefront country/), { target: { value: "gb" } });
  fireEvent.click(screen.getByRole("button", { name: "Search Apple" }));
  fireEvent.click(await screen.findByRole("button", { name: "Preview Selected" }));
  expect(await screen.findByText(/Disc 1, track 1: Full track/)).toBeTruthy();
  expect(screen.getByText(/not remembered for future/)).toBeTruthy();
  fireEvent.error(screen.getByRole("img", { name: "Cover for Selected" }));
  expect(screen.getByText(/Cover unavailable/)).toBeTruthy();
  expect(calls.some((url) => url.endsWith("/confirm"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm this edition" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("Escape closes with no request; changing identification disables the stale dialog", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const props = { original: { title: "Original", artist: "Artist", country: "gb" }, corrected: false, onChanged: vi.fn() };
  const view = render(<AlbumEditionCorrection {...props} binding={binding} />);
  fireEvent.click(screen.getByRole("button", { name: "Correct album edition" }));
  view.rerender(<AlbumEditionCorrection {...props} binding={{ ...binding, revision: 1 }} />);
  expect(screen.getByRole("alert").textContent).toMatch(/changed/);
  expect((screen.getByRole("button", { name: "Search Apple" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
