// Plain facts for filesystem failures while writing a project. The raw system message stays as the detail,
// so diagnostics keep the errno and path while the UI can lead with what is wrong.
const WRITE_FACTS: Record<string, string> = {
  EACCES: "Folder is read-only",
  EPERM: "Folder is read-only",
  EROFS: "Folder is read-only",
  ENOSPC: "Disk is full",
  ENOENT: "Project folder was moved or deleted",
  ENOTDIR: "Project folder was moved or deleted",
  EBUSY: "Folder is busy",
  EMFILE: "Folder is busy",
};

const ERRNO = /^E[A-Z0-9]+$/;
const LEADING_ERRNO = /^(E[A-Z0-9]+):/;

/** The fact for a Node errno code, or null when the failure is not a system write error. */
export function projectWriteFact(code: unknown): string | null {
  if (typeof code !== "string" || !ERRNO.test(code)) return null;
  return WRITE_FACTS[code] ?? "Couldn't write the project";
}

/** Fact for a message that still starts with a raw `ECODE:` clause, for errors that did not pass through main. */
export function projectWriteFactFromMessage(message: string): string | null {
  return projectWriteFact(LEADING_ERRNO.exec(message)?.[1]);
}

/**
 * One message whose first sentence is the plain fact and whose remainder is the raw system detail.
 * Messages without an errno code (validation, changed target, existing project) are returned unchanged.
 */
export function describeProjectWriteError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const fact = projectWriteFact(code) ?? projectWriteFactFromMessage(raw);
  return fact ? `${fact}. ${raw}` : raw;
}

/** The same error when it has no write fact; otherwise an error whose message leads with the fact. */
export function withProjectWriteFact(error: unknown): unknown {
  const message = describeProjectWriteError(error);
  return error instanceof Error && message === error.message ? error : new Error(message);
}
