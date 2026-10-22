import * as React from "react";
import { createPortal } from "react-dom";
import { UI } from "./ui";

const { useEffect, useRef, useState } = React;
const h = React.createElement;

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "Bordeaux could not create the diagnostic preview.");
}

// Focus is lost when it falls to body or stays inside a dialog that is no longer open.
const focusLost = () => {
  const active = document.activeElement;
  return !active || active === document.body || Boolean(active.closest("dialog:not([open])"));
};

export function DiagnosticBundleDialog({ getProject, targetSelector = ".toolbar .tb-right", renderKey, onOpen, onClose }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [toolbarTarget, setToolbarTarget] = useState(null);
  const closeRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    setToolbarTarget(targetSelector ? document.querySelector(targetSelector) : null);
  }, [targetSelector, renderKey]);

  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    dialog.showModal();
    closeRef.current && closeRef.current.focus();
    return () => dialog.close();
  }, [open]);

  const desktopAvailable = Boolean(window.bordeauxAPI && typeof window.bordeauxAPI.previewBetaDiagnostic === "function");
  const busy = phase === "generating" || phase === "saving";
  // React removes the dialog before effect cleanup runs, and removal does not
  // restore focus. Close it while mounted, then return focus if it was lost.
  const close = () => {
    if (busy) return;
    dialogRef.current?.close();
    setOpen(false);
    requestAnimationFrame(() => { if (focusLost()) onClose?.(); });
  };
  const openDialog = () => {
    onOpen?.();
    setOpen(true);
    setPhase("idle");
    setPreview(null);
    setError("");
  };
  const generatePreview = async () => {
    if (!desktopAvailable) return;
    setPhase("generating");
    setError("");
    try {
      const next = await window.bordeauxAPI.previewBetaDiagnostic(getProject());
      if (!next || typeof next.previewId !== "string" || typeof next.contents !== "string") throw new Error("Bordeaux returned an invalid diagnostic preview.");
      setPreview(next);
      setPhase("preview");
    } catch (failure) {
      setPhase("idle");
      setError(errorMessage(failure));
    }
  };
  const savePreview = async () => {
    if (!preview || !window.bordeauxAPI || typeof window.bordeauxAPI.saveBetaDiagnostic !== "function") return;
    setPhase("saving");
    setError("");
    try {
      const result = await window.bordeauxAPI.saveBetaDiagnostic(preview.previewId);
      setPhase(result && result.saved ? "saved" : "cancelled");
    } catch (failure) {
      setPhase("preview");
      setError(errorMessage(failure));
    }
  };

  const trigger = h("button", { className: "robot-push-trigger robot-push-trigger-diagnostics", type: "button", title: "Diagnostics", "aria-label": "Diagnostics", onClick: openDialog, disabled: !desktopAvailable },
    h(UI.Icon, { name: "info", size: 15 }));

  return h(React.Fragment, null,
    toolbarTarget ? createPortal(trigger, toolbarTarget) : null,
    open && h("dialog", { ref: dialogRef, className: "robot-push-dialog robot-diagnostics", "aria-labelledby": "beta-diagnostic-title",
      onCancel: (event) => { event.preventDefault(); close(); },
      onClick: (event) => {
        if (event.target !== dialogRef.current || busy) return;
        const bounds = dialogRef.current.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      } },
        h("header", null,
          h("div", null, h("h2", { id: "beta-diagnostic-title" }, "Diagnostic bundle")),
          h("button", { ref: closeRef, className: "robot-push-close", type: "button", "aria-label": "Close diagnostic bundle", disabled: busy, onClick: close }, "×")),
        h("p", { className: "robot-push-intro" }, "Preview a local support file. Nothing is sent."),
        error && h("div", { className: "robot-push-alert", role: "alert" }, error),
        !desktopAvailable && h("div", { className: "robot-push-section" },
          h("p", null, "Diagnostic bundles are available in the desktop app.")),
        desktopAvailable && phase === "idle" && h("div", { className: "robot-push-section" },
          h("div", { className: "robot-push-actions" }, h("button", { className: "primary", type: "button", onClick: generatePreview }, "Generate preview"))),
        phase === "generating" && h("div", { className: "robot-push-status", role: "status" },
          h("span", { className: "robot-push-spinner" }), h("strong", null, "Building preview…")),
        preview && ["preview", "saving", "saved", "cancelled"].includes(phase) && h("div", { className: "robot-push-section" },
          h("textarea", {
            className: "robot-push-details",
            "aria-label": "Read-only beta diagnostic JSON",
            readOnly: true,
            value: preview.contents,
            rows: 18,
            spellCheck: false,
            style: { display: "block", width: "100%", maxHeight: "360px", padding: "12px", resize: "vertical", overflow: "auto", whiteSpace: "pre", fontFamily: "var(--mono)", fontSize: "11px", lineHeight: 1.45, color: "var(--txt)" },
          }),
          phase === "saving" && h("div", { className: "robot-push-status", role: "status" }, h("span", { className: "robot-push-spinner" }), h("strong", null, "Saving…")),
          phase === "saved" && h("div", { className: "robot-push-outcome active", role: "status" }, h("h3", null, "Diagnostic bundle saved"), h("p", null, "Saved locally. Nothing was sent.")),
          phase === "cancelled" && h("div", { className: "robot-push-outcome", role: "status" }, h("h3", null, "Not saved"), h("p", null, "Choose Save bundle to try again.")),
          phase !== "saving" && h("div", { className: "robot-push-actions" },
            h("button", { type: "button", className: "quiet", onClick: generatePreview }, "Regenerate"),
            h("button", { type: "button", onClick: close }, "Close"),
            phase !== "saved" && h("button", { className: "primary", type: "button", onClick: savePreview }, "Save bundle"))),
      ),
  );
}
