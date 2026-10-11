export const ATTRACTION_LED_STANDARD_V1_MARKER =
  "visual-standard:infoproduct-attraction-led-v1" as const;

export const ATTRACTION_LED_STANDARD_V2_MARKER =
  "visual-standard:infoproduct-attraction-led-v2-packshot" as const;

export const CURRENT_ATTRACTION_LED_STANDARD_MARKER =
  ATTRACTION_LED_STANDARD_V2_MARKER;

export const LEGACY_ATTRACTION_LED_STANDARD_MARKERS = [
  ATTRACTION_LED_STANDARD_V1_MARKER,
] as const;

export function attractionLedStandardVersion(
  selectionLog: readonly string[],
): 1 | 2 | null {
  const normalized = new Set(selectionLog.map((entry) => entry.trim()));
  if (normalized.has(ATTRACTION_LED_STANDARD_V2_MARKER)) return 2;
  if (normalized.has(ATTRACTION_LED_STANDARD_V1_MARKER)) return 1;
  return null;
}
