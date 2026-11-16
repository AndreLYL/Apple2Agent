import { Temporal } from "@js-temporal/polyfill";
export function parseBirthday(value: string) {
  const raw = value.replace(/-/g, "");
  if (!/^(?:\d{4})?\d{4}$/.test(raw)) return undefined;
  const year = raw.length === 8 ? Number(raw.slice(0, 4)) : undefined,
    month = Number(raw.slice(-4, -2)),
    day = Number(raw.slice(-2));
  if (year !== undefined && year < 1) return undefined;
  try {
    Temporal.PlainDate.from(
      { year: year ?? 2000, month, day },
      { overflow: "reject" },
    );
    return { year, month, day };
  } catch {
    return undefined;
  }
}
