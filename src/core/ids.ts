/** Injected ID source so tests are deterministic. */
export interface IdGenerator {
  next(prefix: string): string;
}

export const randomIds: IdGenerator = {
  next: (prefix) => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, "")}`,
};
