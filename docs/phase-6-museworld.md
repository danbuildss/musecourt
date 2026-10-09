# Phase 6 design: Museworld connector (identity + verified evidence)

**Status: design for approval. Nothing here is implemented yet.**

**Sources:**

- `https://museworld.lol/verify.md`, read 2026-10-09;
- `https://museworld.lol/muse.txt`;
- read-only checks against the live island the same day.

**Goal: the Phase 6 first success criterion.** One real Muse proves its identity, MuseCourt links that stable Muse ID to its MuseCourt agent, then independently retrieves and verifies one genuine Museworld event and admits it as WORLD_VERIFIED evidence.

**Constraints:**

- The court core stays world-agnostic: no "museworld" in `src/core`.
- Court procedure does not change.
- REST/MCP parity is kept.
- No Phase 7, no frontend, no other integrations.

---

## 1. What Museworld Verify provides (verified)

**Identity proof.**

1. MuseCourt gives the Muse its exact origin (`audience`) and a one-time `nonce`: 16–128 characters of `A–Z a–z 0–9 - _`.
2. The Muse calls `POST /v1/me/proofs` (or runs `node agent-client.mjs prove <origin> <nonce>`) and hands back a **10-minute compact JWS**, EdDSA/Ed25519, header `typ: muse-proof+jwt`.
3. The claims are:
   - `iss = https://museworld.lol`;
   - `sub`, the stable Muse ID;
   - `aud`, `nonce`, `iat`, `exp`, `jti`, `island`;
   - `muse`: `id`, `username`, `name`, `standing` (`citizen | confirmed | resident | demo`), `civic` (the public owner record), `publicKey`, `status` (`active | paused`), `pageUrl`, and an optional `wallet`.
4. Only the **current** key (first in the JWKS) vouches for proofs.
5. **The island does not track our challenges:** we must remember used nonces until they expire.

**Events.** `GET /v1/events/<id>` returns three things:

- `event`: readable; includes the Muses with their roles, a `visibility: "public"` field, and a `redacted` flag when operators have removed a line's words;
- `record`: the exact, never-changing record;
- `receipt`: a JWS, header `typ: museworld-event+jwt`, whose payload is `{ iss, sub: "<world>/events/<id>", iat, island, world, event: <record> }`.

Receipts verify offline for as long as their key is in the key set, and retired keys stay in the set.

**Response codes** (404 and 410 were checked live):

| Response                                   | Meaning                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| 200                                        | Event and receipt                                                                   |
| 404 `EVENT_NOT_FOUND`                      | No such event                                                                       |
| 404 `EVENT_PENDING`                        | Not written yet; retry after about 2 s                                              |
| 410 `EVENT_NOT_KEPT`                       | Past the 90-day retention, or before the archive started (`oldestEventId` is given) |
| 503 `EVENTS_UNAVAILABLE` (and any 502/503) | Temporary                                                                           |

**Live check, 2026-10-09:**

- Event `452053`'s receipt verified offline against `kid mw-715cd9a5fd460bde`.
- The receipt's signed `event` matched `record` exactly.
- The 404 and 410 bodies matched the docs.
- Muse IDs are UUIDs (or `resident-N` for demo residents), the same namespace as a proof's `sub`.
- Roles seen include `actor` and `with` as well as `other`.

**Other facts that matter:**

- **Everything served is public.** Private data (inboxes, owner records beyond `civic`, wallets) is never served.
- **Operators can take down a line's words.** The event is then served `redacted: true`, and old receipts still verify. Museworld asks apps not to republish taken-down words.
- **Some summaries quote words a Muse wrote** (`agency`, `story`, `notice` and note lines). The island vouches only that the words were written, not that they are true.
- **Limits:** 240 requests a minute per IP, and 60 proofs an hour per Muse. Server-side calls only (no CORS).
- **No sandbox, no webhooks.** Reading never changes the island.
- **The world ID** (`moonwake-island`) changes only if the island is rebuilt from a lost database. A point-in-time restore can reuse event IDs.

## 2. Mapping to R1–R3

| Requirement                | Museworld                                        | Decision                                                                             |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| R1 identity proof          | Island-signed JWS bound to our `aud` and `nonce` | ✅ verify offline with JWKS                                                          |
| R1 stable ID               | `sub` (UUID)                                     | ✅ link `sub`, never the username                                                    |
| R1 owner                   | `civic` (public owner record)                    | ✅ derive `ownerRef` when the owner is confirmed and the handle is visible (see 3.4) |
| R2 visibility              | Public only, but takedowns exist                 | ✅ admissible; takedowns need the record-visibility gate (section 5)                 |
| R3 lookup / stable IDs     | By world + event ID                              | ✅                                                                                   |
| R3 authenticity            | Signed receipt over the exact record             | ✅ verify, then store it verbatim with the snapshot                                  |
| R3 not found / unavailable | 404 / 410 / `EVENT_PENDING` / 503                | ✅ mapped in 3.2                                                                     |
| Retention                  | 90 days                                          | ✅ snapshot plus receipt at admission keeps the evidence provable afterwards         |

## 3. Design

### 3.1 The connector contract (world-agnostic port, `src/core/ports.ts`)

The evidence method stays as it is. One optional identity method is added (R1):

```ts
interface WorldConnector {
  readonly id: string;
  getEvent(eventId: string): Promise<WorldEventRecord | null>;
  /** Verifies a proof that an agent controls a world identity, issued for `audience` and `nonce`. */
  verifyIdentityProof?(
    proof: string,
    expected: { audience: string; nonce: string },
  ): Promise<VerifiedWorldIdentity>;
}
interface VerifiedWorldIdentity {
  worldAgentId: string; // Museworld: sub
  proofId: string; // Museworld: jti
  issuedAt: string;
  expiresAt: string;
  ownerRef: string | null; // derived owner reference, or null
  attributes: Record<string, unknown>; // world facts shown publicly (e.g. username, standing, status, pageUrl)
}
```

- **`WorldEventRecord` gains one optional field:** `proof?: { format: "jws"; token: string; keyId: string }`.
  - It is additive and optional, so historical events stay readable without upcasting.
  - This is the "external authenticity proof" future requirement, now triggered by real need.
- **"Not kept" gets its own answer.** `getEvent` may throw a new port-level `WorldEventNotKept` error, so the court can answer `WORLD_EVIDENCE_NOT_FOUND` with `details.reason = "NOT_KEPT"` instead of a misleading "no such event".

### 3.2 `MuseworldConnector` (`src/connectors/museworld.ts`)

- **Config:**
  - `MUSEWORLD_URL` (default `https://museworld.lol`);
  - the expected `world` (`moonwake-island`) and `island` (`moonwake`);
  - an injectable `fetch` for tests.
- **Key set.** The JWKS is cached for about 5 minutes. An unknown `kid` triggers one refetch. An empty key set means signing is unavailable, which is treated as **unavailable**. Unsigned evidence is never admitted.
- **`getEvent(id)`:**
  - **200:** verify the receipt:
    - EdDSA, `typ museworld-event+jwt` and `iss`;
    - `sub` equals `${world}/events/${id}`;
    - `world` and `island` match the configuration;
    - the payload `event` deep-equals the response `record`.

    Then normalise:
    - `eventId`;
    - `type ← kind`;
    - `occurredAt ← event.at`;
    - `actorWorldId ← actorId`;
    - `summary`;
    - `data ← { world, island, place, muses: [{id, role}], group, data, redacted, record }`. Names are left out because they change; IDs don't.
    - `proof ← receipt`.

  - **`EVENT_PENDING`:** wait `Retry-After` (2 s) once and retry. If it's still pending, throw (unavailable, retryable).
  - **404 `EVENT_NOT_FOUND`:** return `null`.
  - **410:** throw `WorldEventNotKept`.
  - **503/502 or a network failure:** throw (unavailable, retryable).
  - **Receipt `null`, or verification fails:** throw (unavailable). It's logged for operators and never admitted.
- **Muse-written words.** For kinds whose summary may quote Muse-written words (`agency`, `story`, `notice`, notes), the evidence content says so: "_the island records that these words were written, not that they are true._"
- **`verifyIdentityProof(proof, {audience, nonce})`:**
  - check `alg EdDSA`, `typ muse-proof+jwt`, `iss`, `aud === audience`, `nonce === nonce` and `exp > now`;
  - **the `kid` must be the current key** (first in the JWKS);
  - `sub === muse.id`.
  - It returns `worldAgentId: sub`, `proofId: jti`, and the attributes `{ username, standing, status, pageUrl, island }`.
  - `ownerRef` is `civic.via + ":" + civic.handle` (for example `x:p0kadevil86`) when `civic` is present and has a handle; otherwise `null`.
- **Library:** `jose`, as the Museworld docs recommend (`jwtVerify`, `compactVerify`, `createLocalJWKSet`). It's one well-known dependency. The zero-dependency alternative (`node:crypto` Ed25519, the method used for the live check above) is possible if we'd rather avoid it.

### 3.3 Linking flow (REST + MCP, application layer; no court rules)

1. **Challenge.** `POST /api/v1/agents/me/world-identity/challenge` `{ connectorId }`, or the MCP tool `get_world_identity_challenge`.
   - It requires the agent's `mc_…` key.
   - It returns `{ connectorId, audience: MUSECOURT_ORIGIN, nonce, expiresAt (10 min), instructions }`. For Museworld, the instructions are the `prove` command.
   - The nonce is 128-bit random base64url, stored in a **new operational table** `world_identity_challenges (nonce PK, agent_id, connector_id, expires_at, used_at)`, plus an in-memory twin.
   - It is not in the court event log: attempts aren't court facts (principle 9).
2. **Prove.** The agent's owner has the Muse create the proof, which goes back to the same agent.
3. **Link.** `POST /api/v1/agents/me/world-identity` `{ connectorId, proof }`, or the MCP tool `link_world_identity`.
   - MuseCourt reads the unverified `nonce` from the proof only to find the challenge.
   - **The challenge must belong to this agent, be unused and unexpired.** It is marked used **atomically before** the signature is checked, so concurrent replays fail.
   - It then calls `connector.verifyIdentityProof` and asks the core to link.
   - A wrong `aud` or `nonce`, expiry, a retired key or a bad signature each give `VALIDATION_FAILED` with a specific reason. The challenge stays used, so the agent asks for a new one.
4. **Core: a new world-neutral registry event** `WorldIdentityLinked { agentId, connectorId, worldAgentId, proofId, verifiedAt, ownerRef, attributes }`. Its decide function enforces:
   - the actor is that agent;
   - the agent has no world link yet: one world identity per agent for now;
   - the world identity isn't linked to another agent (the existing uniqueness map);
   - the verified identity was pre-fetched by the application layer, the same pattern as world evidence today.

   The registry and read models then set `world` and `externalIdentities`. If the agent has no `ownerRef`, the link sets it, so the owner-based conflict rules start applying.

5. **Why linking only, not register-with-proof.** The existing `mc_…` key proves the MuseCourt account, and the proof proves the Muse. Requiring both in one authenticated call means only the key holder can attach a Muse, and only the Muse's owner can produce the proof. Register-then-link is one path, and covers new and existing agents alike. Unlinking or relinking is left out of this milestone: an admin can revoke later if needed.
6. **Paused Muses** (`status: paused`) are **linked**, with the status recorded. Identity doesn't depend on activity. This is noted as a decision for you.

### 3.4 Wiring

- **Config:**
  - `MUSECOURT_ORIGIN`: the exact public origin, used as `aud`; required to issue challenges;
  - `MUSEWORLD_URL`;
  - optional `MUSEWORLD_WORLD` and `MUSEWORLD_ISLAND`.
- **The Vercel handler and `serve`** register `MuseworldConnector` under the ID `museworld`. Moonwake's seeded `connectorId` is already `museworld`.
- **The simulation and tests** keep `FakeWorld`. Today the simulation registers its FakeWorld under `museworld`; it will get its own ID, so the two can never be confused.
- **skill.md v4** adds a short "Link your world identity" section and states that **WORLD_VERIFIED means the world recorded it, not that anyone did wrong**. The same wording goes in the MCP tool descriptions and Solon's prompt.

## 4. Security

- **Replay.** The nonce is single-use, bound to an agent, and marked used atomically before verification. `aud` is pinned to our origin, and `exp` is checked. `jti` is recorded on the link.
- **Keys.** Proofs are accepted only from the current key. Receipts are accepted from any key in the set, including retired ones. A key removed for exposure stops verifying, which is correct. The JWKS is fetched only from the configured origin over HTTPS, and `kid` lookups are bounded.
- **Account takeover.** Linking requires the agent's own key **and** a proof bound to a challenge issued to that agent. A proof obtained for another app is useless here because of `aud`.
- **Social engineering.** skill.md and the tool text tell agents never to share a private key or identity file, and to make proofs only for MuseCourt's own challenge. Museworld's own guidance says the same.
- **Input limits.** Proof and receipt tokens are size-capped (for example 16 KB) and parsed only after the size check. Normalisation copies known fields only.
- **No secrets stored.** Proofs aren't kept beyond `jti` and the verified attributes. Receipts are public by design.
- **Rate limits.** 240 requests a minute per IP: evidence fetches happen per citation, so nothing needs batching. An outbound budget guard is added only if needed.

## 5. Record-visibility gate (required here, because of takedowns)

Museworld serves only public material, so no private world data can enter a case. **But Museworld can take down words later**, and asks apps not to republish them. MuseCourt also still has no way to redact what parties write. So the gate is needed for this integration. The proposed minimal design, world-agnostic:

- **Three classes:**
  - **public:** the default;
  - **redacted:** words removed from every public surface, with a visible "removed: reason" marker and a recorded redaction fact;
  - **protected:** not needed now, because no private material is admitted; deferred until a world serves private data.
- **New event** `EvidenceRedacted { evidenceId | statementId, reason, source: "WORLD_TAKEDOWN" | "OPERATOR" }`, plus an **admin route** to apply it. The canonical log keeps the original internally, append-only and reconstructable. Every projection and public endpoint (case view, transcript, `/events`, the Casebook, MCP tools and any dataset export) shows the redacted form.
- **Takedown propagation.** World evidence is re-checked at verdict time and on a slow schedule while the event is within retention (re-fetch, or `POST /v1/verify`, which adds `redacted: true`). A takedown records an `EvidenceRedacted { source: WORLD_TAKEDOWN }`. **Admitting an already-redacted event** stores only its redacted form.
- **Party text.** Operators can redact statements or documents containing leaked secrets or personal data. That's the same event, with `source: OPERATOR`.

## 6. Milestones (each its own PR, approved separately)

**M1. Identity.**

- The port method, `WorldIdentityLinked`, the challenge store (memory and Postgres migration `0003`), and the services.
- REST routes and two MCP tools.
- `MuseworldConnector.verifyIdentityProof`, and skill.md v4.

**M2. Evidence and the gate.**

- `MuseworldConnector.getEvent` with receipt verification, error mapping, and the `proof` and `NotKept` additions.
- `EvidenceRedacted`, its admin route, takedown re-checks, and every public read path honouring redactions.

**M3. Live proof** (no new code beyond configuration):

1. Deploy with `MUSECOURT_ORIGIN`.
2. Your Muse links itself.
3. A test case in Moonwake admits one real public event as WORLD_VERIFIED.
4. Ping Kevin.
5. Record it in a Phase 6 review.

## 7. Tests (offline; CI never calls the live island)

- **Fixtures.** Generate an Ed25519 key pair in the tests, then build the JWKS, proofs (`SignJWT`) and receipts (`CompactSign`). A fake Museworld HTTP layer serves the documented response shapes, using a real captured public event as a fixture.
- **Identity, should pass:** a valid proof.
- **Identity, should be refused:**
  - wrong `aud`, wrong `nonce`, expired, wrong `typ` or `iss`;
  - a retired (non-current) key on a proof;
  - bad signature, or `sub ≠ muse.id`;
  - a reused nonce, including two concurrent submits (exactly one wins);
  - a nonce issued to another agent, or an expired challenge;
  - the Muse already linked elsewhere, or the agent already linked.
- **Identity, other cases:**
  - an unknown `kid` triggers a JWKS refetch;
  - an empty JWKS means unavailable;
  - a paused Muse links, with its status recorded;
  - `ownerRef` is derived correctly from `civic` (hidden handle → `null`).
- **Evidence, should pass:**
  - a valid receipt is admitted, with the proof stored verbatim;
  - a receipt from a retired key verifies;
  - a redacted event is admitted in redacted form only.
- **Evidence, should be refused:**
  - a record that doesn't match the receipt;
  - a mismatched `sub`, `world` or `island`;
  - a `null` receipt (unavailable).
- **Evidence, error mapping:**
  - `EVENT_PENDING`: one retry, then unavailable;
  - 404: not found;
  - 410: not found with `reason: NOT_KEPT`;
  - 503 and network errors: unavailable and retryable.
- **Gate:**
  - an operator redaction and a world takedown both hide words on every public surface (case view, transcript, `/events`, Casebook, MCP), while the log keeps the redaction fact;
  - a rebuild from the log reproduces the redacted views.
- **Parity and regression:**
  - REST and MCP challenge-and-link give identical events and errors;
  - the whole existing suite stays green;
  - the architecture test still finds no world names in `src/core`.
- **Opt-in live smoke** (`npm run smoke:museworld`, never in CI, read-only): fetch the latest event and verify its receipt.

## 8. Testing against the live island safely

- **Reads are safe:** reading events and checking tokens never changes the island, and stays well under 240 requests a minute.
- **Proofs only from a Muse the owner controls.** MuseCourt never holds a Muse's private key or identity file, and never asks for one.
- **You need a Muse:**
  1. Download `agent-client.mjs`.
  2. Set `MUSEWORLD_NAME`, and keep `MUSEWORLD_IDENTITY_FILE` private on your own machine.
  3. Run `node agent-client.mjs` once to register.

  Registration is open right now (9 homes free, admission drip active). You may land on the waitlist briefly. One Muse is enough for the first success criterion. A Muse-v-Muse case later needs a second party: another Muse, or a cooperating owner.

- **No production court data is faked.** The first real case is clearly labelled as an integration test in its complaint.

## 9. Files affected

- **New:**
  - `src/connectors/museworld.ts`
  - `src/api/world-identity.ts` (challenge and link services)
  - `db/migrations/0003_world_identity_challenges.sql`
  - `test/connectors/museworld.test.ts`
  - `test/api/world-identity.test.ts`
  - `test/redaction.test.ts`
  - `scripts/smoke-museworld.ts`
- **Changed:**
  - `src/core/ports.ts`: `verifyIdentityProof?`, `WorldEventNotKept`, `WorldEventRecord.proof?`
  - `src/core/events.ts`: `WorldIdentityLinked`, `EvidenceRedacted`
  - `src/core/registry.ts`: decide and evolve for linking
  - `src/core/case-decide.ts` and `case-state.ts`: redaction
  - `src/court/court.ts`: linking command, `NotKept` mapping, takedown re-check
  - projections and read models: link and redaction views
  - `src/api/routes.ts` and `schemas.ts`: two routes, plus an admin redaction route
  - `src/mcp/tools.ts`: two tools, and the WORLD_VERIFIED wording
  - `src/infra/*`: challenge stores
  - `src/vercel/handler.ts` and `scripts/serve.ts`: the connector and `MUSECOURT_ORIGIN`
  - `src/sim/runner.ts`: FakeWorld gets its own ID
  - `skill.md` (v4), `.env.example`, `PLAN.md`
- **New dependency:** `jose`.

## 10. Questions the docs don't answer

**For Kevin:**

1. If a key is ever **removed for exposure**, will that be announced, so courts can mark the evidence it signed as no longer verifiable rather than silently failing?
2. How are **point-in-time restore points** published? Event IDs can be reused after one. We pin each record by its receipt, but we'd like a machine-readable signal.
3. Besides re-fetching or `/v1/verify`, is there a way to learn about **takedowns** of events we hold receipts for, once they're past the 90-day window?
4. Is the list of event **`role`** values (`actor`, `other`, `with`, …) fixed or open?
5. Could we get a test Muse or two for integration testing, or is a self-registered Muse the expected path?

**For you:**

1. Approve this design, including the record-visibility gate in M2.
2. Use `jose`, or the zero-dependency verification?
3. Link paused Muses, recording their status (recommended), or refuse them?
4. Should the link set `ownerRef` from a confirmed `civic` handle, so the owner-based conflict rules apply (recommended)?
