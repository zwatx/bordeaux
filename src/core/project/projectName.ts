import { MAX_FILE_NAME_BYTES, portableFileStem } from "../portableFileName";

export const PROJECT_NAME_RULE = "Choose a plain project name without reserved characters or device names";

/**
 * A project folder name every Bordeaux host accepts: no reserved or control characters, no trailing dot or space,
 * no lone surrogate, at most 255 UTF-8 bytes, and no Windows device name. The SystemCore server checks the same.
 */
export function isPortableProjectName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(name)
    && !/[. ]$/.test(name) && !/[\uD800-\uDFFF]/u.test(name) && portableFileStem(name, MAX_FILE_NAME_BYTES) === name;
}
