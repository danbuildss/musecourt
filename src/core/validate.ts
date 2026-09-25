import { fail } from "./errors";

/** Trims and length-checks free text from agents. */
export function requireText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") fail("VALIDATION_FAILED", `${field} must be a string.`, { field });
  const text = value.trim();
  if (text.length < min)
    fail("VALIDATION_FAILED", `${field} must be at least ${min} characters.`, { field, min });
  if (text.length > max)
    fail("VALIDATION_FAILED", `${field} must be at most ${max} characters.`, { field, max });
  return text;
}

export function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  return requireText(value, field, 0, max);
}

export function requireStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail("VALIDATION_FAILED", `${field} must be an array of strings.`, { field });
  }
  const unique = new Set(value as string[]);
  if (unique.size !== value.length)
    fail("VALIDATION_FAILED", `${field} must not contain duplicates.`, { field });
  return value as string[];
}
