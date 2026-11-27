import { statfsSync } from "node:fs";
import { OFFICIAL_RELEASES_URL } from "../core/appUpdates";
export { OFFICIAL_RELEASES_URL };

// Release tags are `v<version>`. Only a plain semantic version from main's own update state becomes a tag link; anything
// else falls back to the release list.
export function releasePageUrl(version: string | null | undefined): string {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
    ? `${OFFICIAL_RELEASES_URL}/tag/v${version}`
    : OFFICIAL_RELEASES_URL;
}

/**
 * Free space an update needs: the download, the updater's cached copy and the unpacked app (about 260 MB on macOS),
 * which Squirrel.Mac stages again before replacing the installed one.
 */
export const UPDATE_FREE_BYTES = 1024 ** 3;
const DISK_SPACE_TEXT = "Free up at least 1 GB of disk space, then try the update again.";

/** The least free space among the volumes an update writes to, or null if none can be read. */
export function freeUpdateSpace(directories: string[]): number | null {
  let least: number | null = null;
  for (const directory of directories) {
    try {
      const stats = statfsSync(directory);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(free) && (least === null || free < least)) least = free;
    } catch { /* An unreadable volume says nothing about space. */ }
  }
  return least;
}

/**
 * The first sentence is what the update panel shows. `freeBytes` is measured when the failure is reported: Squirrel.Mac
 * reports an app it could not finish unpacking on a full disk as a code signature failure, not as a disk error.
 */
export function describeUpdateFailure(message: string, freeBytes: number | null = null): string {
  // Response bodies can contain entire proxy error pages. Use only the error
  // prefix for classification and keep the original message for Copy details.
  const diagnostic = message.split(/<!doctype\b|<html\b|<body\b/i, 1)[0];
  const diskFull = /\bENOSPC\b|no space left|not enough (?:free |disk )*space|disk (?:is )?full/i.test(diagnostic);
  const lowSpace = freeBytes !== null && freeBytes < UPDATE_FREE_BYTES;
  const signatureFailure = /signature|code requirement|codesign/i.test(diagnostic);
  const accessDenied = /\b403\b|\bforbidden\b/i.test(diagnostic);
  const networkFailure = /network|ENOTFOUND|ECONN|ETIMEDOUT|internet|timed? out/i.test(diagnostic);
  // The panel shows only the first sentence, so this one carries both the cause and the fix.
  if (diskFull) return DISK_SPACE_TEXT;
  if (accessDenied) return "The update request was denied (HTTP 403). GitHub or a network filter may be blocking the connection. Try again later or on another network, or open the official Bordeaux releases page to download an installer.";
  if (networkFailure) return "Check your internet connection and try Check for Updates again. You can also download an installer from the official Bordeaux releases page.";
  // Low space explains a signature or unexplained failure; a network or HTTP failure above keeps its own advice.
  if (lowSpace) return DISK_SPACE_TEXT;
  if (signatureFailure) return "The downloaded update could not be verified. Save your work, then download an installer from the official Bordeaux releases page and replace the installed app manually.";
  return "Try Check for Updates again, or download an installer from the official Bordeaux releases page.";
}
