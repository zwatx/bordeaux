/**
 * One name component: 255 bytes on Linux filesystems such as ext4, 255 UTF-16
 * units on APFS and NTFS. A UTF-8 byte count is never below the UTF-16 count.
 */
export const MAX_FILE_NAME_BYTES = 255;

// Windows opens these devices instead of a file, even with an extension or
// spaces before it, so `CON.bdx` and `nul .path` are not usable file names.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/i;

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, cut on a code point boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0, end = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    // Lone surrogates encode as U+FFFD, three bytes.
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * Bound an already character-sanitized stem to `maxBytes` UTF-8 bytes and
 * prefix `_` to Windows device names, within the same byte budget.
 */
export function portableFileStem(stem: string, maxBytes: number): string {
  // A caller's UTF-16 character cap may have split the final surrogate pair.
  const whole = stem.replace(/[\uD800-\uDBFF]$/, "");
  const bounded = truncateUtf8(whole, maxBytes);
  return WINDOWS_DEVICE_NAME.test(bounded) ? `_${truncateUtf8(whole, maxBytes - 1)}` : bounded;
}
