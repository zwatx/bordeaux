type UnitSystem = "metric" | "imperial";
type UnitDefinition = { label: string; factor: number };
type UnitStorage = Pick<Storage, "getItem" | "setItem">;
type UnitRoot = { dataset: DOMStringMap | Record<string, string> };

/** Angular limits stay in degrees in both unit systems; positive values never display as zero. */
export function formatAngularLimit(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  const text = value.toFixed(magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2);
  return String(Number(value !== 0 && Number(text) === 0 ? value.toPrecision(2) : text));
}

// The document selects display units; local storage supplies the default for older files.
// Project geometry, planning, validation, and export remain SI.
export function createUnitPreferences(storage: UnitStorage = localStorage, root: UnitRoot = document.documentElement) {
  const STORAGE_KEY = 'bordeaux.unitSystem';
  const definitions: Record<string, UnitDefinition> = {
    m: { label: 'ft', factor: 3.280839895013123 },
    in: { label: 'in', factor: 39.37007874015748 },
    'm/s': { label: 'ft/s', factor: 3.280839895013123 },
    'm/s²': { label: 'ft/s²', factor: 3.280839895013123 },
    'm²': { label: 'ft²', factor: 10.763910416709722 },
    '1/m': { label: '1/ft', factor: 0.3048 },
    kg: { label: 'lb', factor: 2.2046226218487757 },
    'N·m': { label: 'lb·ft', factor: 0.7375621492772656 },
    'kg·m²': { label: 'lb·ft²', factor: 23.73036040423187 },
  };
  let current: UnitSystem = 'metric';
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === 'imperial') current = stored;
  } catch (_) {}

  const definition = (unit: string, imperialUnit?: string) => definitions[imperialUnit || unit];
  const fromCanonical = (value: number, unit: string, imperialUnit?: string) => current === 'imperial' && definition(unit, imperialUnit)
    ? value * definition(unit, imperialUnit).factor : value;
  const toCanonical = (value: number, unit: string, imperialUnit?: string) => current === 'imperial' && definition(unit, imperialUnit)
    ? value / definition(unit, imperialUnit).factor : value;
  const label = (unit: string, imperialUnit?: string) => current === 'imperial' && definition(unit, imperialUnit)
    ? definition(unit, imperialUnit).label : unit;
  const format = (value: number, unit: string, precision: number, imperialUnit?: string) => fromCanonical(value, unit, imperialUnit).toFixed(precision) + ' ' + label(unit, imperialUnit);
  const set = (next: string): UnitSystem => {
    current = next === 'imperial' ? 'imperial' : 'metric';
    root.dataset.units = current;
    try { storage.setItem(STORAGE_KEY, current); } catch (_) {}
    return current;
  };
  root.dataset.units = current;

  return { current: () => current, set, fromCanonical, toCanonical, label, format };
}

const fallbackStorage: UnitStorage = { getItem: () => null, setItem: () => undefined };
const fallbackRoot: UnitRoot = { dataset: {} };

export const UnitPrefs = createUnitPreferences(
  typeof localStorage === "undefined" ? fallbackStorage : localStorage,
  typeof document === "undefined" ? fallbackRoot : document.documentElement,
);
