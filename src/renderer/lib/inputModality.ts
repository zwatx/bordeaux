/**
 * Marks the root with the last kind of pointer pressed (`data-input="touch"` for a finger or pen, `"mouse"` otherwise), so
 * controls that otherwise appear only on hover stay visible while someone works by touch. Opacity only: nothing reflows.
 */
export function installInputModality(doc: Document = document): void {
  const root = doc.documentElement;
  doc.addEventListener("pointerdown", (event) => {
    const input = event.pointerType === "touch" || event.pointerType === "pen" ? "touch" : "mouse";
    if (root.dataset.input !== input) root.dataset.input = input;
  }, { capture: true, passive: true });
}
