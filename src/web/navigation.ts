import { useCallback } from "react";
import type { RemoteKey } from "../shared/remote.js";
import type { NavigationAction } from "./remoteEvents.js";

type Adjustment = (direction: -1 | 1) => void;
const adjustments = new WeakMap<HTMLElement, Adjustment>();

export function useNavigationAdjustment(adjust: Adjustment) {
  return useCallback((element: HTMLInputElement | null) => {
    if (!element) return;
    adjustments.set(element, adjust);
    return () => { adjustments.delete(element); };
  }, [adjust]);
}

export function keyboardNavigationKey(key: string): RemoteKey | undefined {
  switch (key) {
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "Enter": case " ": return "select";
    case "Escape": case "BrowserBack": return "back";
  }
}

export function navigationVisible(element: HTMLElement): boolean {
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
      const summary = ancestor.querySelector(":scope > summary");
      if (!summary?.contains(element)) return false;
    }
    const style = getComputedStyle(ancestor);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

export function focusNavigation(element: HTMLElement | null | undefined) {
  if (!element) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
}

export function focusCurrentView(root: HTMLElement) {
  const selected = root.querySelector<HTMLElement>("[role='tab'][aria-selected='true']:not(:disabled)");
  focusNavigation(selected ?? root.querySelector<HTMLElement>(".ambient-library > summary, .settings > summary"));
}

const controlsSelector = "button:not(:disabled), summary, input:not(:disabled):not([type='hidden']), a[href], [data-navigation-scroll][tabindex]";
function leavesDisplay(element: HTMLElement) {
  return element instanceof HTMLAnchorElement
    && (element.origin !== window.location.origin || Boolean(element.target && element.target !== "_self"));
}

/** Real DOM actions shared by physical keyboard and the ephemeral remote stream. */
export function navigate(
  root: HTMLElement, action: NavigationAction, target: HTMLElement | null = document.activeElement as HTMLElement,
  options: { allowExternalLinks?: boolean } = {},
): boolean {
  const { key, repeat } = action;
  if (repeat && (key === "select" || key === "back")) return true;
  const dialog = [...root.querySelectorAll<HTMLElement>("[data-navigation-dialog]")].find(navigationVisible);
  if (key === "back") {
    const cancel = dialog?.querySelector<HTMLButtonElement>("[data-navigation-cancel]");
    if (cancel) { cancel.click(); return true; }
    const open = [...root.querySelectorAll<HTMLDetailsElement>("details[open]")].filter(navigationVisible);
    const closest = target?.closest<HTMLDetailsElement>("details[open]");
    const panel = (closest && root.contains(closest) ? open.filter((item) => closest.contains(item)) : open).at(-1);
    if (panel) { panel.open = false; focusNavigation(panel.querySelector("summary")); }
    else focusCurrentView(root);
    return true;
  }
  if (!target || !root.contains(target) || !navigationVisible(target)) {
    if (dialog) focusNavigation(dialog.querySelector<HTMLElement>("[data-navigation-cancel]"));
    else focusCurrentView(root);
    return true;
  }
  if (dialog && !dialog.contains(target)) {
    focusNavigation(dialog.querySelector<HTMLElement>("[data-navigation-cancel]"));
    return true;
  }
  if (target.isContentEditable || target.closest("textarea, select, [contenteditable]")) return false;
  const horizontal = key === "left" || key === "right";
  const backwards = key === "left" || key === "up";
  if (key === "select") {
    if (options.allowExternalLinks === false && leavesDisplay(target)) return true;
    // Browser file pickers require a real user gesture and stay admin-only.
    if (target.matches("input[type='file']")) return false;
    if (target.matches("button:not(:disabled), summary, a[href], input[type='checkbox']:not(:disabled), input[type='radio']:not(:disabled)")) {
      target.click();
      return true;
    }
    return false;
  }
  if (horizontal && adjustments.has(target)) {
    adjustments.get(target)!(backwards ? -1 : 1);
    return true;
  }
  if (target instanceof HTMLInputElement && !["checkbox", "radio", "file"].includes(target.type)
    && !adjustments.has(target)) return false;
  if (target.matches("[data-navigation-scroll]") && !horizontal) {
    target.scrollTop += (backwards ? -1 : 1) * Math.max(80, Math.round(target.clientHeight * 0.65));
    return true;
  }
  if (target.getAttribute("role") === "tab" && horizontal) {
    const tabs = [...target.parentElement!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    focusNavigation(tabs[(tabs.indexOf(target as HTMLButtonElement) + (backwards ? -1 : 1) + tabs.length) % tabs.length]);
    return true;
  }
  const panel = target.closest<HTMLElement>(".settings[open], .ambient-library[open]");
  const scope = dialog ?? panel ?? root;
  const controls = [...scope.querySelectorAll<HTMLElement>(controlsSelector)]
    .filter((element) => navigationVisible(element) && (options.allowExternalLinks !== false || !leavesDisplay(element)));
  const bounds = target.getBoundingClientRect();
  const candidates = controls.filter((element) => element !== target).map((element) => {
    const rect = element.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - bounds.left - bounds.width / 2;
    const dy = rect.top + rect.height / 2 - bounds.top - bounds.height / 2;
    const along = horizontal ? dx : dy;
    return { element, forward: backwards ? -along : along, score: Math.abs(along) + Math.abs(horizontal ? dy : dx) * 3 };
  }).filter(({ forward }) => forward > 1).sort((a, b) => a.score - b.score);
  const index = controls.indexOf(target);
  const fallback = index < 0 ? 0 : (index + (backwards ? -1 : 1) + controls.length) % controls.length;
  focusNavigation(candidates[0]?.element ?? controls[fallback]);
  return true;
}
