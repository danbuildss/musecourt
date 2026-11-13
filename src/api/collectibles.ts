import { agentActor } from "@/core/actor";
import { fail } from "@/core/errors";
import { linkRequestStatus } from "@/core/collectibles";
import type { ApiDeps } from "./app";
import { normalizeAddress, recoverSigner } from "./wallet";

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/** A link request as the agent and the holder see it: what to sign, where, and by when. */
export async function linkRequestView(deps: ApiDeps, requestId: string, now: Date, origin: string) {
  const { record, message, agentHandle, collection } = await deps.court.getLinkRequest(requestId);
  return {
    requestId: record.requestId,
    status: linkRequestStatus(record, now),
    collection: { id: collection.id, name: collection.name },
    item: { tokenId: record.tokenId, name: record.name, label: `${collection.itemWord} #${record.tokenId}` },
    agent: agentHandle,
    wallet: record.holder,
    expiresAt: record.expiresAt,
    message,
    signWith:
      "personal_sign (EIP-191) from the wallet named in `wallet`: sign `message` exactly as given. It is not a transaction and moves nothing.",
    /** A page where a person signs with a browser wallet (MetaMask, Rabby…). */
    signUrl: `${origin}/musegod/sign/${record.requestId}`,
    confirm: `POST ${origin}/api/v1/collectible-links/${record.requestId} with {"signature": "0x…"}`,
  };
}

/** The agent asks to show an item; by default the wallet it signs in with holds it. */
export async function requestLink(
  deps: ApiDeps,
  agentId: string,
  input: { collection: string; tokenId: number; wallet?: string },
) {
  let holder = input.wallet ? normalizeAddress(input.wallet) : null;
  if (!holder) {
    holder =
      (await deps.court.getRegistry()).agents.get(agentId)?.wallet ??
      fail(
        "VALIDATION_FAILED",
        "Name the wallet that holds the item in `wallet` (you have no wallet linked).",
        {
          field: "wallet",
        },
      );
  }
  return deps.court.requestCollectibleLink(agentActor(agentId), {
    collectionId: input.collection,
    tokenId: input.tokenId,
    holder,
  });
}

/** The holder's signature over the request's line. Anyone may deliver it: the signature is the proof. */
export async function confirmLink(deps: ApiDeps, requestId: string, signature: string) {
  const { message } = await deps.court.getLinkRequest(requestId);
  const signer = SIGNATURE.test(signature) ? recoverSigner(message, signature) : null;
  return deps.court.confirmCollectibleLink(requestId, signer);
}
