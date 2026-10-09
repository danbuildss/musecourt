import { museworldConnectorFromEnv } from "@/connectors/museworld";

/**
 * Opt-in, read-only check of the Museworld connector against the live island. Never runs in CI.
 *   npm run smoke:museworld            the latest public event
 *   npm run smoke:museworld -- 452053  a given event
 * It reads one event, verifies its receipt offline, and re-checks it with /v1/verify. Reading
 * never changes the island. It prints no event text (the court decides what is shown).
 */
const base = (process.env.MUSEWORLD_URL || "https://museworld.lol").replace(/\/$/, "");
const connector = museworldConnectorFromEnv();

let eventId = process.argv.slice(2).find((a) => /^\d+$/.test(a));
if (!eventId) {
  const res = await fetch(`${base}/v1/events?limit=1`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Listing events answered ${res.status}.`);
  const body = (await res.json()) as { events?: Array<{ id: number }> };
  eventId = String(body.events?.[0]?.id ?? "");
  if (!eventId) throw new Error("The island returned no events.");
}

const record = await connector.getEvent(eventId);
if (!record) throw new Error(`Event ${eventId} was not found.`);
console.log(`PASS  event ${eventId} receipt verified (kind ${record.type}, key ${record.proof?.keyId})`);
console.log(`      occurred ${record.occurredAt}${record.redacted ? ", already taken down" : ""}`);
const recheck = await connector.recheckEvent(record);
console.log(`PASS  /v1/verify re-check: ${recheck.redacted ? "taken down" : "not taken down"}`);
console.log("\nMUSEWORLD SMOKE TEST PASSED");
