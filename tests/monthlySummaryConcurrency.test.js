require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedSchema = require("../src/seed/schema");
const seedExpenseSplits = require("../src/seed/expenseSplits");
const seedReturns = require("../src/seed/returns");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  rebuildAffectedMonthlyFinancialSummaries,
  compareFacts,
  monthlySummaryLockKeys,
  uniqueSummaryTargets,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `msc_${Date.now()}`;
const YEAR = 2026;

let userId;
let otherUserId;

function factsOf(row) {
  const facts = {};
  FACT_FIELDS.forEach((field) => {
    facts[field] = row ? row[field] : 0;
  });
  return facts;
}

async function expectSummaryMatchesSource(uid, year, month) {
  const current = await computeMonthFacts(uid, year, month);
  const summary = await getMonthlyFinancialSummary(uid, year, month);
  const mismatches = compareFacts(current, summary).filter(
    (row) => row.difference !== 0
  );
  expect(mismatches).toEqual([]);
  return factsOf(summary);
}

async function insertExpense(client, uid, amount, date) {
  await client.query(
    `INSERT INTO expenses (amount, expense_type, expense_date, category, user_id)
     VALUES ($1, TRUE, $2, 'LockTest', $3)`,
    [amount, parseTimestamp(date), uid]
  );
}

async function runExpenseTxn(uid, amount, date) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await insertExpense(client, uid, amount, date);
    const parts = date.split("-");
    await rebuildAffectedMonthlyFinancialSummaries(
      [{ user_id: uid, year: Number(parts[0]), month: Number(parts[1]) }],
      client
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

describe("monthly summary concurrent rebuild locking", () => {
  beforeAll(async () => {
    await seedSchema();
    await seedExpenseSplits();
    await seedReturns();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MSC Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MSC Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      if (!id) continue;
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [id]);
      await db.query(`DELETE FROM monthly_financial_summary WHERE user_id = $1`, [
        id,
      ]);
      await db.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
  });

  test("lock keys are unique per user/month and collision-free for valid months", () => {
    const a = monthlySummaryLockKeys(userId, 2026, 1);
    const b = monthlySummaryLockKeys(userId, 2026, 2);
    const c = monthlySummaryLockKeys(otherUserId, 2026, 1);
    expect(a.userKey).toBe(userId);
    expect(a.monthKey).not.toBe(b.monthKey);
    expect(a.userKey).not.toBe(c.userKey);
    expect(a.monthKey).toBe(c.monthKey);
    const seen = new Set();
    for (let year = 2020; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        const key = `${userId}:${monthlySummaryLockKeys(userId, year, month).monthKey}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  test("affected keys are deduped and sorted by user, year, month", () => {
    const sorted = uniqueSummaryTargets([
      { user_id: otherUserId, year: 2026, month: 12 },
      { user_id: userId, year: 2026, month: 2 },
      { user_id: userId, year: 2026, month: 2 },
      { user_id: userId, year: 2025, month: 12 },
      { user_id: userId, year: 2026, month: 1 },
    ]);
    expect(sorted).toEqual([
      { user_id: userId, year: 2025, month: 12 },
      { user_id: userId, year: 2026, month: 1 },
      { user_id: userId, year: 2026, month: 2 },
      { user_id: otherUserId, year: 2026, month: 12 },
    ]);
  });

  test("same month concurrent mutations match source after both commit", async () => {
    await Promise.all([
      runExpenseTxn(userId, 100, `${YEAR}-04-10`),
      runExpenseTxn(userId, 50, `${YEAR}-04-11`),
    ]);
    const summary = await expectSummaryMatchesSource(userId, YEAR, 4);
    expect(summary.expenses).toBe(150);
  });

  test("rebuild waits on the same-month lock, then sees the committed sibling", async () => {
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("BEGIN");
      await insertExpense(a, userId, 25, `${YEAR}-05-04`);
      await rebuildMonthlyFinancialSummary(userId, YEAR, 5, a);

      await b.query("BEGIN");
      await insertExpense(b, userId, 75, `${YEAR}-05-05`);
      await b.query("SAVEPOINT before_rebuild");
      await b.query("SET LOCAL lock_timeout = '200ms'");
      await expect(
        rebuildMonthlyFinancialSummary(userId, YEAR, 5, b)
      ).rejects.toThrow(/lock timeout/i);
      await b.query("ROLLBACK TO SAVEPOINT before_rebuild");

      await a.query("COMMIT");
      await rebuildMonthlyFinancialSummary(userId, YEAR, 5, b);
      await b.query("COMMIT");
    } catch (err) {
      try {
        await a.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      try {
        await b.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      a.release();
      b.release();
    }

    const summary = await expectSummaryMatchesSource(userId, YEAR, 5);
    expect(summary.expenses).toBe(100);
  });

  test("different months do not share the month lock", async () => {
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("BEGIN");
      await insertExpense(a, userId, 10, `${YEAR}-06-01`);
      await rebuildMonthlyFinancialSummary(userId, YEAR, 6, a);

      await b.query("BEGIN");
      await insertExpense(b, userId, 20, `${YEAR}-07-01`);
      await b.query("SET LOCAL lock_timeout = '200ms'");
      await rebuildMonthlyFinancialSummary(userId, YEAR, 7, b);
      await b.query("COMMIT");
      await a.query("COMMIT");
    } catch (err) {
      try {
        await a.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      try {
        await b.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      a.release();
      b.release();
    }

    await expectSummaryMatchesSource(userId, YEAR, 6);
    await expectSummaryMatchesSource(userId, YEAR, 7);
  });

  test("different users do not share the month lock", async () => {
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("BEGIN");
      await insertExpense(a, userId, 11, `${YEAR}-08-01`);
      await rebuildMonthlyFinancialSummary(userId, YEAR, 8, a);

      await b.query("BEGIN");
      await insertExpense(b, otherUserId, 22, `${YEAR}-08-01`);
      await b.query("SET LOCAL lock_timeout = '200ms'");
      await rebuildMonthlyFinancialSummary(otherUserId, YEAR, 8, b);
      await b.query("COMMIT");
      await a.query("COMMIT");
    } catch (err) {
      try {
        await a.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      try {
        await b.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      a.release();
      b.release();
    }

    await expectSummaryMatchesSource(userId, YEAR, 8);
    await expectSummaryMatchesSource(otherUserId, YEAR, 8);
  });

  test("multi-month rebuilds sort locks and do not deadlock", async () => {
    await Promise.all([
      (async () => {
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          await insertExpense(client, userId, 5, `${YEAR}-01-02`);
          await insertExpense(client, userId, 7, `${YEAR}-12-02`);
          await rebuildAffectedMonthlyFinancialSummaries(
            [
              { user_id: userId, year: YEAR, month: 12 },
              { user_id: userId, year: YEAR, month: 1 },
            ],
            client
          );
          await client.query("COMMIT");
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {
            /* ignore */
          }
          throw err;
        } finally {
          client.release();
        }
      })(),
      (async () => {
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          await insertExpense(client, userId, 3, `${YEAR}-01-15`);
          await insertExpense(client, userId, 9, `${YEAR}-12-15`);
          await rebuildAffectedMonthlyFinancialSummaries(
            [
              { user_id: userId, year: YEAR, month: 1 },
              { user_id: userId, year: YEAR, month: 12 },
            ],
            client
          );
          await client.query("COMMIT");
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch (_) {
            /* ignore */
          }
          throw err;
        } finally {
          client.release();
        }
      })(),
    ]);

    const jan = await expectSummaryMatchesSource(userId, YEAR, 1);
    const dec = await expectSummaryMatchesSource(userId, YEAR, 12);
    expect(jan.expenses).toBe(8);
    expect(dec.expenses).toBe(16);
  });

  test("rebuild failure rolls back the source mutation", async () => {
    const before = factsOf(
      (await getMonthlyFinancialSummary(userId, YEAR, 9)) || { expenses: 0 }
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await insertExpense(client, userId, 999, `${YEAR}-09-09`);
      await rebuildMonthlyFinancialSummary(userId, YEAR, 9, client);
      await client.query("SELECT 1 / 0");
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        /* ignore */
      }
      expect(String(err.message || err)).toMatch(/division by zero/i);
    } finally {
      client.release();
    }

    const leftover = await db.query(
      `SELECT COUNT(*)::int AS n FROM expenses
       WHERE user_id = $1 AND category = 'LockTest' AND amount = 999`,
      [userId]
    );
    expect(leftover.rows[0].n).toBe(0);
    const after = factsOf(
      (await getMonthlyFinancialSummary(userId, YEAR, 9)) || { expenses: 0 }
    );
    expect(after.expenses).toBe(before.expenses || 0);
  });

  test("repeated rebuild is idempotent", async () => {
    await runExpenseTxn(userId, 40, `${YEAR}-10-10`);
    const first = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 10)
    );
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 10)
    );
    expect(second).toEqual(first);
    await expectSummaryMatchesSource(userId, YEAR, 10);
  });
});
