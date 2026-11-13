import { CourtError } from "@/core/errors";
import type { CollectibleItem, CollectionConnector } from "@/core/ports";

/**
 * MUSEGOD's Muses: 999 plush NFTs on Robinhood Chain, each an ERC-8004 agent controlled by whoever
 * holds it. MuseCourt reads who holds a Muse from MUSEGOD's public, keyless API
 * (GET /api/v1/muses/{id}). MuseCourt is not affiliated with MUSEGOD; it only reads public data.
 */

export const MUSEGOD_COLLECTION_ID = "musegod";
export const MUSEGOD_SUPPLY = 999;
const FETCH_TIMEOUT_MS = 8_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export class MusegodCollection implements CollectionConnector {
  readonly id = MUSEGOD_COLLECTION_ID;
  readonly name = "MUSEGOD Muses";
  readonly itemWord = "Muse";
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? "https://musegod.org").replace(/\/+$/, "");
    this.fetchFn = options.fetch ?? fetch;
  }

  async lookup(tokenId: number): Promise<CollectibleItem | null> {
    if (!Number.isInteger(tokenId) || tokenId < 1 || tokenId > MUSEGOD_SUPPLY) return null;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/v1/muses/${tokenId}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (res.status === 404) return null;
    if (!res.ok) throw unavailable();
    const body = (await res.json().catch(() => null)) as {
      id?: unknown;
      name?: unknown;
      owner?: { address?: unknown };
      links?: { page?: unknown; images?: Record<string, unknown> };
    } | null;
    const holder = body?.owner?.address;
    if (body?.id !== tokenId || typeof holder !== "string" || !ADDRESS.test(holder)) throw unavailable();
    const image = body.links?.images?.["480"];
    return {
      tokenId,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 80)
          : `Muse #${tokenId}`,
      holder: holder.toLowerCase(),
      image: typeof image === "string" && image.startsWith(`${this.baseUrl}/`) ? image : null,
      url: `${this.baseUrl}/m/${tokenId}`,
    };
  }
}

function unavailable(): CourtError {
  return new CourtError(
    "WORLD_UNAVAILABLE",
    "MUSEGOD's API could not be reached to check who holds this Muse. Try again shortly.",
  );
}
