import * as React from "react";
import { isMacPlatform } from "./keyBindings";
import { createFieldScrollPreference, type FieldScrollMode, type ScrollStorage } from "./zoom";

const fallbackStorage: ScrollStorage = { getItem: () => null, setItem: () => undefined };

export const FieldScrollPrefs = createFieldScrollPreference(
  typeof localStorage === "undefined" ? fallbackStorage : localStorage,
  typeof window !== "undefined" && isMacPlatform() ? "pan" : "zoom",
);

export function useFieldScrollMode(): FieldScrollMode {
  return React.useSyncExternalStore(FieldScrollPrefs.subscribe, FieldScrollPrefs.current, FieldScrollPrefs.current);
}
