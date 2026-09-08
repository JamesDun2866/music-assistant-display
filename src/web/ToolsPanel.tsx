import { useId, useLayoutEffect, useRef, useState } from "react";
import { focusNavigation, keyboardNavigationKey, navigate, navigationDialog, navigationVisible } from "./navigation.js";
import { useSourceTelemetry } from "./useSourceTelemetry.js";
import { StereoMeters } from "./StereoMeters.js";
import { RecordingLibrary } from "./RecordingLibrary.js";
import { SourceHealth } from "./SourceHealth.js";
import "./source-tools.css";

export interface ToolsSection {
  id: string;
  title: string;
  content: React.ReactNode;
}

function MeterSection() {
  const telemetry = useSourceTelemetry();
  return <StereoMeters telemetry={telemetry} />;
}

export function ToolsPanel({ onClose, extraSections = [] }: {
  onClose: () => void; extraSections?: readonly ToolsSection[];
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const prefix = useId();
  const [selected, setSelected] = useState("meters");
  const sections: ToolsSection[] = [
    { id: "meters", title: "Meters", content: <MeterSection /> },
    { id: "recordings", title: "Recordings", content: <RecordingLibrary /> },
    { id: "health", title: "Health", content: <SourceHealth /> },
    ...extraSections,
  ];
  if (new Set(sections.map(({ id }) => id)).size !== sections.length) {
    throw new Error("Tools section IDs must be unique.");
  }
  const active = sections.find(({ id }) => id === selected) ?? sections[0]!;
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusNavigation(close.current);
    return () => {
      // The App removes background inertness in the same commit as this unmount.
      queueMicrotask(() => {
        if (previous?.isConnected && navigationVisible(previous)) focusNavigation(previous);
      });
    };
  }, []);
  return <div className="source-tools-overlay" ref={root}>
    <div className="source-tools-panel" role="dialog" aria-modal="true"
      aria-labelledby={`${prefix}-title`} data-navigation-dialog
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || !root.current) return;
        event.stopPropagation();
        if (event.defaultPrevented) return;
        if (event.key === "Tab") {
          const scope = navigationDialog(root.current) ?? root.current;
          const controls = [...scope.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), a[href], [tabindex='0']",
          )].filter(navigationVisible);
          const index = controls.indexOf(document.activeElement as HTMLElement);
          if (event.shiftKey && index <= 0) { event.preventDefault(); focusNavigation(controls.at(-1)); }
          else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); focusNavigation(controls[0]); }
          return;
        }
        const key = keyboardNavigationKey(event.key);
        if (key && navigate(root.current, { key, repeat: event.repeat }, event.target as HTMLElement)) event.preventDefault();
      }}>
      <header><h1 id={`${prefix}-title`}>Source tools</h1>
        <button ref={close} type="button" data-navigation-cancel onClick={onClose}>Close tools</button></header>
      <div role="tablist" aria-label="Tools sections" className="source-tools-tabs">
        {sections.map((section) => <button key={section.id} type="button" role="tab"
          id={`${prefix}-tab-${section.id}`} aria-selected={active.id === section.id}
          tabIndex={active.id === section.id ? 0 : -1} aria-controls={`${prefix}-content`}
          onClick={() => setSelected(section.id)}>{section.title}</button>)}
      </div>
      <div className="source-tools-content" id={`${prefix}-content`} role="tabpanel"
        aria-labelledby={`${prefix}-tab-${active.id}`} tabIndex={0} data-navigation-scroll>
        {active.content}
      </div>
    </div>
  </div>;
}
