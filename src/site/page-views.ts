/**
 * Public page-view counts: a number per page per UTC day, and nothing about who viewed.
 * Operational state, not court record.
 */
export interface PageViewTotals {
  today: number;
  yesterday: number;
  all: number;
  /** The first day anything was counted (null before the first view). */
  since: string | null;
}

export interface PageViewStore {
  record(day: string, page: string): Promise<void>;
  totals(today: string, yesterday: string): Promise<PageViewTotals>;
}

/** Pages the counter accepts; anything else is ignored, so the table stays small and bounded. */
export const COUNTED_PAGES = ["home", "casebook", "case", "join", "roadmap", "stats"] as const;
export type CountedPage = (typeof COUNTED_PAGES)[number];

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
