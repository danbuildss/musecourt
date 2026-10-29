import { describe, expect, it } from "vitest";
import { isConnectError, makeResilient } from "@/infra/resilient-pool";

const fakePool = (failures: unknown[]) => {
  let calls = 0;
  const pool = {
    calls: () => calls,
    async query() {
      calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return { rows: [{ ok: true }] };
    },
    async connect() {
      calls += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return { release() {} };
    },
  };
  return pool;
};
const noSleep = { sleep: async () => undefined };

describe("database connection retries", () => {
  it("retries a query whose connection could not be made, then succeeds", async () => {
    const pool = makeResilient(
      fakePool([Object.assign(new Error("too many clients"), { code: "53300" })]) as never,
      noSleep,
    ) as never as ReturnType<typeof fakePool>;
    expect(await pool.query()).toEqual({ rows: [{ ok: true }] });
    expect(pool.calls()).toBe(2);
  });

  it("never retries an error from a query that was sent: a write must not run twice", async () => {
    const pool = makeResilient(
      fakePool([Object.assign(new Error("duplicate key"), { code: "23505" })]) as never,
      noSleep,
    ) as never as ReturnType<typeof fakePool>;
    await expect(pool.query()).rejects.toThrow("duplicate key");
    expect(pool.calls()).toBe(1);
  });

  it("gives up after three tries, and retries connects the same way", async () => {
    const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const pool = makeResilient(
      fakePool([refused(), refused(), refused()]) as never,
      noSleep,
    ) as never as ReturnType<typeof fakePool>;
    await expect(pool.connect()).rejects.toThrow("ECONNREFUSED");
    expect(pool.calls()).toBe(3);
  });

  it("knows a connect failure from a query failure", () => {
    expect(isConnectError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isConnectError(Object.assign(new Error("x"), { code: "57P03" }))).toBe(true);
    expect(
      isConnectError(Object.assign(new Error("Connection terminated unexpectedly"), { code: undefined })),
    ).toBe(false);
    expect(isConnectError(Object.assign(new Error("x"), { code: "40001" }))).toBe(false);
  });
});

describe.runIf(process.env.TEST_DATABASE_URL)("a real resilient pool", () => {
  it("still runs queries, transactions and connects normally", async () => {
    const pg = (await import("pg")).default;
    const pool = makeResilient(new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }));
    try {
      expect((await pool.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
      const client = await pool.connect();
      await client.query("BEGIN");
      expect((await client.query("SELECT 2 AS two")).rows).toEqual([{ two: 2 }]);
      await client.query("COMMIT");
      client.release();
      const results = await Promise.all([1, 2, 3, 4, 5].map((n) => pool.query("SELECT $1::int AS n", [n])));
      expect(results.map((r) => r.rows[0].n)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await pool.end();
    }
  });
});
