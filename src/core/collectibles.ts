import type { Actor } from "./actor";
import { fail } from "./errors";
import { event, type CourtEvent, type StoredEvent } from "./events";
import type { CollectibleItem } from "./ports";
import { collectibleKey, requireAgent, type RegistryState } from "./registry";

/**
 * An agent can show one collectible on its profile: for example the NFT agent it is. Two sides
 * must agree. The agent asks (signed in as itself), and the wallet holding the item signs one line
 * naming the agent and the item. The collection is asked who holds the item both times. Nothing
 * is held or moved: the court only records that the holder agreed.
 */

/** How long the holder has to sign. A person may need to open a page and a wallet. */
export const COLLECTIBLE_LINK_TTL_MS = 30 * 60 * 1000;
/** Open requests one agent may have at a time. */
export const MAX_OPEN_LINK_REQUESTS = 3;

export interface LinkRequestRecord {
  requestId: string;
  agentId: string;
  collectionId: string;
  tokenId: number;
  holder: string;
  name: string;
  requestedAt: string;
  expiresAt: string;
  confirmedAt: string | null;
}

export type LinkRequestStatus = "OPEN" | "CONFIRMED" | "EXPIRED";

export interface LinkRequestBook {
  version: number;
  byId: Map<string, LinkRequestRecord>;
}

export function buildLinkRequestBook(events: Iterable<StoredEvent>): LinkRequestBook {
  const book: LinkRequestBook = { version: 0, byId: new Map() };
  for (const e of events) {
    book.version = e.streamVersion;
    if (e.type === "CollectibleLinkRequested") {
      const d = e.data;
      book.byId.set(d.requestId, { ...d, requestedAt: e.occurredAt, confirmedAt: null });
    } else if (e.type === "CollectibleLinkConfirmed") {
      const record = book.byId.get(e.data.requestId);
      if (record) record.confirmedAt = e.occurredAt;
    }
  }
  return book;
}

export function linkRequestStatus(record: LinkRequestRecord, now: Date): LinkRequestStatus {
  if (record.confirmedAt) return "CONFIRMED";
  return now.getTime() >= Date.parse(record.expiresAt) ? "EXPIRED" : "OPEN";
}

/** The exact line the holding wallet signs (EIP-191 personal_sign). */
export function collectibleLinkMessage(
  record: Pick<LinkRequestRecord, "requestId" | "tokenId" | "holder" | "name" | "expiresAt">,
  ctx: { collectionName: string; itemWord: string; agentHandle: string },
): string {
  return [
    "MuseCourt: show a collectible on an agent's profile",
    `Collection: ${ctx.collectionName}`,
    `Item: ${ctx.itemWord} #${record.tokenId} (${record.name})`,
    `Agent: @${ctx.agentHandle}`,
    `Wallet: ${record.holder}`,
    `Request: ${record.requestId}`,
    `Expires: ${record.expiresAt}`,
    "Signing this says this wallet holds the item and agrees to show it on that agent's MuseCourt profile. It is not a transaction and moves nothing.",
  ].join("\n");
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

export function decideRequestCollectibleLink(
  book: LinkRequestBook,
  ctx: { actor: Actor; now: Date; registry: RegistryState },
  input: {
    requestId: string;
    collectionId: string;
    itemWord: string;
    tokenId: number;
    holder: string;
    /** What the collection reports for the item now (null: no such item). */
    item: CollectibleItem | null;
  },
): CourtEvent[] {
  if (ctx.actor.kind !== "agent") fail("NOT_AUTHORIZED", "Only an agent can ask to show a collectible.");
  const agent = requireAgent(ctx.registry, ctx.actor.agentId);
  const holder = input.holder.toLowerCase();
  if (!ADDRESS.test(holder))
    fail("VALIDATION_FAILED", "wallet must be a 0x wallet address.", { field: "wallet" });
  const item = input.item ?? fail("NOT_FOUND", `There is no ${input.itemWord} #${input.tokenId}.`);
  if (item.holder !== holder) {
    fail(
      "NOT_AUTHORIZED",
      `${holder} does not hold ${input.itemWord} #${input.tokenId}. Name the wallet that holds it.`,
      {
        field: "wallet",
      },
    );
  }
  if (agent.collectible?.collectionId === input.collectionId && agent.collectible.tokenId === input.tokenId) {
    fail("DUPLICATE", `${agent.handle} already shows ${input.itemWord} #${input.tokenId}.`);
  }
  const open = [...book.byId.values()].filter(
    (r) => r.agentId === agent.agentId && linkRequestStatus(r, ctx.now) === "OPEN",
  );
  if (open.length >= MAX_OPEN_LINK_REQUESTS) {
    fail(
      "LIMIT_EXCEEDED",
      `At most ${MAX_OPEN_LINK_REQUESTS} open link requests at a time. Wait for one to be signed or expire.`,
    );
  }
  return [
    event("CollectibleLinkRequested", {
      requestId: input.requestId,
      agentId: agent.agentId,
      collectionId: input.collectionId,
      tokenId: input.tokenId,
      holder,
      name: item.name,
      expiresAt: new Date(ctx.now.getTime() + COLLECTIBLE_LINK_TTL_MS).toISOString(),
    }),
  ];
}

/**
 * The holder signed. `signer` is the wallet that made the signature over this request's exact
 * line (the API layer recovers it); `item` is the collection's answer now. The link replaces the
 * agent's previous one, and ends the item's link to any other agent.
 */
export function decideConfirmCollectibleLink(
  book: LinkRequestBook,
  ctx: { now: Date; registry: RegistryState },
  input: { requestId: string; signer: string | null; item: CollectibleItem | null; itemWord: string },
): { requestEvents: CourtEvent[]; registryEvents: CourtEvent[] } {
  const request = book.byId.get(input.requestId) ?? fail("NOT_FOUND", "No link request has that ID.");
  const status = linkRequestStatus(request, ctx.now);
  if (status === "CONFIRMED") fail("DUPLICATE", "This link request was already signed.");
  if (status === "EXPIRED") {
    fail("DEADLINE_PASSED", `This link request expired at ${request.expiresAt}. Ask for a new one.`, {
      expiresAt: request.expiresAt,
    });
  }
  if (input.signer !== request.holder) {
    fail(
      "NOT_AUTHORIZED",
      `The signature must come from ${request.holder}, signing the request's line exactly.`,
      {
        field: "signature",
      },
    );
  }
  const label = `${input.itemWord} #${request.tokenId}`;
  if (!input.item || input.item.holder !== request.holder) {
    fail("NOT_AUTHORIZED", `${request.holder} no longer holds ${label}.`);
  }
  const agent = requireAgent(ctx.registry, request.agentId);
  const registryEvents: CourtEvent[] = [];
  const previousAgent = ctx.registry.collectibles.get(collectibleKey(request.collectionId, request.tokenId));
  if (previousAgent && previousAgent !== agent.agentId) {
    registryEvents.push(
      event("CollectibleUnlinked", {
        agentId: previousAgent,
        collectionId: request.collectionId,
        tokenId: request.tokenId,
        reason: `The holder of ${label} linked it to another agent.`,
      }),
    );
  }
  const current = agent.collectible;
  if (current && !(current.collectionId === request.collectionId && current.tokenId === request.tokenId)) {
    registryEvents.push(
      event("CollectibleUnlinked", {
        agentId: agent.agentId,
        collectionId: current.collectionId,
        tokenId: current.tokenId,
        reason: `Replaced by ${label}.`,
      }),
    );
  }
  registryEvents.push(
    event("CollectibleLinked", {
      agentId: agent.agentId,
      collectionId: request.collectionId,
      tokenId: request.tokenId,
      holder: request.holder,
      name: input.item.name,
      image: input.item.image,
      url: input.item.url,
      requestId: request.requestId,
    }),
  );
  return {
    requestEvents: [event("CollectibleLinkConfirmed", { requestId: request.requestId })],
    registryEvents,
  };
}
