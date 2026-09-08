// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ListeningJournal } from "../src/web/ListeningJournal.js";
const execute = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../src/web/useLocalCommand.js", () => ({
  useLocalCommand: () => ({ execute, pending: false, error: null, notice: null }),
}));
const revision = "a".repeat(32);
const page = {
  entries: [{ id: 1, identifiedAt: 1_700_000_000_000, clockAdjusted: false, title: "Original title",
    artist: "Original artist", artworkUrl: null }],
  nextCursor: "older", revision, retentionDays: 90, status: "ready", message: null,
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("shows original dated context, export and bounded-page navigation without starting recognition", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => page }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => { render(<ListeningJournal />); });
  expect(screen.getByRole("heading", { name: "Original title" })).toBeInTheDocument();
  expect(screen.getByText("Cover unavailable")).toBeInTheDocument();
  expect(screen.getByText(/not songs played/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Export JSON" })).toHaveAttribute("href", "/api/listening-journal/export");
  expect(execute).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Older identifications" })));
  expect(fetcher).toHaveBeenLastCalledWith("/api/listening-journal?cursor=older", expect.anything());
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
});

it("requires explicit confirmation and source revision to clear, with cancel focus and Escape", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => page })));
  await act(async () => { render(<ListeningJournal />); });
  fireEvent.click(screen.getByRole("button", { name: "Clear journal" }));
  expect(execute).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear journal" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Clear journal" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm clear journal" })));
  expect(execute).toHaveBeenCalledWith("/api/listening-journal/clear", { confirm: true, revision }, "Journal cleared.");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("rejects foreign artwork and displays errors rather than unsafe journal data", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
    ...page, entries: [{ ...page.entries[0], artworkUrl: "https://external.example/cover" }],
  }) })));
  await act(async () => { render(<ListeningJournal />); });
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toBeInTheDocument();
});
