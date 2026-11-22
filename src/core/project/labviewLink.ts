/** A link is relative to the Bordeaux project folder, with portable slash separators. */
export function normalizeLabviewProjectPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u001f:]/.test(value)) throw new Error("LabVIEW link must be a local relative .lvproj path");
  const slash = value.replace(/\\/g, "/");
  if (slash.startsWith("/")) throw new Error("LabVIEW link must be a local relative .lvproj path");
  const parts: string[] = [];
  for (const part of slash.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  const normalized = parts.join("/");
  if (!/[^/]+\.lvproj$/i.test(normalized) || parts.some(part => part !== ".." && /[. ]$/.test(part))) throw new Error("LabVIEW link must name a .lvproj file");
  return normalized;
}
