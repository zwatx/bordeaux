import { COMMANDS } from "../../core/project.js";

export const commandDef = (id) => COMMANDS.find((c) => c.id === id);
export const markerLabel = (m) => commandDef(m?.invocation?.commandId || m?.cmd || m?.name)?.label || m?.name || "Command";
export const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export const fmtTime = (t) => (t == null || !Number.isFinite(t) ? "—" : t.toFixed(2));
