import { describe, expect, it } from "vitest";
import { agentActor } from "@/core/actor";
import { isCourtError } from "@/core/errors";
import { event } from "@/core/events";
import type { EventStore } from "@/core/ports";
import { expectCourtError } from "./helpers";

const opts = { actor: agentActor("a"), occurredAt: new Date("2026-01-01T00:00:00Z") };
const sample = () => event("CaseDocketed", { caseId: "c", caseNumber: "FW-0001", sequence: 1 });

/** Contract shared by every EventStore implementation (the Postgres test reuses it). */
export function eventStoreContract(name: string, makeStore: () => Promise<EventStore>) {
  describe(`${name}: event store contract`, () => {
    it("assigns contiguous stream versions and increasing global positions", async () => {
      const store = await makeStore();
      await store.append([{ streamId: "s1", expectedVersion: 0, events: [sample(), sample()] }], opts);
      await store.append([{ streamId: "s2", expectedVersion: 0, events: [sample()] }], opts);
      await store.append([{ streamId: "s1", expectedVersion: 2, events: [sample()] }], opts);
      expect((await store.readStream("s1")).map((e) => e.streamVersion)).toEqual([1, 2, 3]);
      const all = await store.readAll();
      expect(all.map((e) => e.globalPosition)).toEqual(
        [...all.map((e) => e.globalPosition)].sort((a, b) => a - b),
      );
      expect(all.map((e) => e.streamId)).toEqual(["s1", "s1", "s2", "s1"]);
      expect((await store.readAll(all[1]!.globalPosition)).map((e) => e.streamId)).toEqual(["s2", "s1"]);
    });

    it("round-trips event data, actor and time exactly", async () => {
      const store = await makeStore();
      const [stored] = await store.append([{ streamId: "s", expectedVersion: 0, events: [sample()] }], opts);
      const [read] = await store.readStream("s");
      expect(read).toEqual(stored);
      expect(read).toMatchObject({
        type: "CaseDocketed",
        data: { caseNumber: "FW-0001" },
        actor: opts.actor,
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("rejects a stale expected version (optimistic concurrency)", async () => {
      const store = await makeStore();
      await store.append([{ streamId: "s", expectedVersion: 0, events: [sample()] }], opts);
      await expectCourtError(
        store.append([{ streamId: "s", expectedVersion: 0, events: [sample()] }], opts),
        "CONCURRENCY_CONFLICT",
      );
      await expectCourtError(
        store.append([{ streamId: "s", expectedVersion: 5, events: [sample()] }], opts),
        "CONCURRENCY_CONFLICT",
      );
    });

    it("appends across streams atomically: one stale stream writes nothing", async () => {
      const store = await makeStore();
      await store.append([{ streamId: "a", expectedVersion: 0, events: [sample()] }], opts);
      await expectCourtError(
        store.append(
          [
            { streamId: "b", expectedVersion: 0, events: [sample()] },
            { streamId: "a", expectedVersion: 0, events: [sample()] },
          ],
          opts,
        ),
        "CONCURRENCY_CONFLICT",
      );
      expect(await store.readStream("b")).toEqual([]);
      expect(await store.readAll()).toHaveLength(1);
    });

    it("of two concurrent writers to the same stream, exactly one wins", async () => {
      const store = await makeStore();
      const results = await Promise.allSettled([
        store.append([{ streamId: "race", expectedVersion: 0, events: [sample()] }], opts),
        store.append([{ streamId: "race", expectedVersion: 0, events: [sample()] }], opts),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(isCourtError(rejected.reason, "CONCURRENCY_CONFLICT")).toBe(true);
      expect(await store.readStream("race")).toHaveLength(1);
    });

    it("returns copies: callers cannot mutate stored history", async () => {
      const store = await makeStore();
      await store.append([{ streamId: "s", expectedVersion: 0, events: [sample()] }], opts);
      const [first] = await store.readStream("s");
      (first!.data as { caseNumber: string }).caseNumber = "TAMPERED";
      expect((await store.readStream("s"))[0]!.data).toMatchObject({ caseNumber: "FW-0001" });
    });
  });
}
