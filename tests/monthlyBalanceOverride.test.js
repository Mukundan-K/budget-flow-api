require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedPayments = require("../src/seed/payments");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const overviewRoutes = require("../src/routes/overview.routes");
const {
  buildMonthOverviewFromSource,
  buildMonthOverviewFromSummary,
} = overviewRoutes;
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");
const {
  compareOverviews,
} = require("../src/services/financial/monthOverviewCompare");

const SUFFIX = `mbo_${Date.now()}`;
const YEAR = 2025;

let userId;
let incomeTypeId;
let server;
let baseUrl;

function factsOf(row) {
  const facts = {};
  FACT_FIELDS.forEach((field) => {
    facts[field] = row ? row[field] : 0;
  });
  return facts;
}

async function expectSummaryMatchesSource(year, month) {
  const current = await computeMonthFacts(userId, year, month);
  const summary = await getMonthlyFinancialSummary(userId, year, month);
  const mismatches = compareFacts(current, summary).filter(
    (row) => row.difference !== 0
  );
  expect(mismatches).toEqual([]);
  return factsOf(summary);
}

async function expectSourceMatchesSummary(year, month) {
  const source = await buildMonthOverviewFromSource(userId, year, month);
  const summary = await buildMonthOverviewFromSummary(userId, year, month);
  expect(compareOverviews(source, summary).mismatches).toEqual([]);
  return summary;
}

async function jsonRequest(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function insertIncome(amount, date) {
  await db.query(
    `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
     VALUES ($1, $2, $3, $4)`,
    [amount, parseTimestamp(date), userId, incomeTypeId]
  );
}

async function rebuild(year, month) {
  return rebuildMonthlyFinancialSummary(userId, year, month);
}

async function upsertPrevious(year, month, amount, method = "PUT") {
  return jsonRequest(method, "/api/overview/previous-balance", {
    user_id: userId,
    year,
    month,
    previous_month_balance: amount,
  });
}

describe("monthly_balances override Remaining chain", () => {
  beforeAll(async () => {
    await seedPayments();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MBO Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const income = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'incoming', TRUE)
       RETURNING id`,
      [`${SUFFIX}_income`]
    );
    incomeTypeId = income.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/overview", overviewRoutes);

    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (!userId) return;
    await db.query(`DELETE FROM payments WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM monthly_balances WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM monthly_financial_summary WHERE user_id = $1`, [
      userId,
    ]);
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (userId) {
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (incomeTypeId) {
      await db.query(`DELETE FROM payment_types WHERE id = $1`, [incomeTypeId]);
    }
  });

  test("A — no override: February previous is January Remaining", async () => {
    await insertIncome(20000, `${YEAR}-01-15`);
    await rebuild(YEAR, 1);

    const jan = await expectSourceMatchesSummary(YEAR, 1);
    const feb = await expectSourceMatchesSummary(YEAR, 2);

    expect(jan.previous_balance).toBe(0);
    expect(jan.previous_balance_manual).toBe(false);
    expect(jan.remaining).toBe(20000);
    expect(feb.previous_balance).toBe(20000);
    expect(feb.previous_balance_manual).toBe(false);
    expect(feb.remaining).toBe(20000);
    expect(feb.earned).toBe(0);
  });

  test("B — explicit zero override is used instead of January Remaining", async () => {
    await insertIncome(20000, `${YEAR}-01-15`);
    await rebuild(YEAR, 1);

    const created = await upsertPrevious(YEAR, 2, 0);
    expect(created.status).toBe(200);
    expect(created.json.data.previous_balance.previous_month_balance).toBe(0);

    const jan = await buildMonthOverviewFromSummary(userId, YEAR, 1);
    const feb = await expectSourceMatchesSummary(YEAR, 2);

    expect(jan.remaining).toBe(20000);
    expect(feb.previous_balance).toBe(0);
    expect(feb.previous_balance_manual).toBe(true);
    expect(feb.previous_balance_calculated).toBe(20000);
    expect(feb.remaining).toBe(0);
  });

  test("C — changing an override updates that month and later un-overridden months", async () => {
    await insertIncome(10000, `${YEAR}-01-10`);
    await rebuild(YEAR, 1);

    const first = await upsertPrevious(YEAR, 2, 30000);
    expect(first.status).toBe(200);

    const febBefore = await buildMonthOverviewFromSummary(userId, YEAR, 2);
    const marBefore = await buildMonthOverviewFromSummary(userId, YEAR, 3);
    expect(febBefore.previous_balance).toBe(30000);
    expect(febBefore.remaining).toBe(30000);
    expect(marBefore.previous_balance).toBe(30000);
    expect(marBefore.previous_balance_manual).toBe(false);

    const factsBefore = await expectSummaryMatchesSource(YEAR, 2);

    const updated = await upsertPrevious(YEAR, 2, 40000, "PATCH");
    expect(updated.status).toBe(200);
    expect(updated.json.data.overview.previous_balance).toBe(40000);
    expect(updated.json.data.overview.remaining).toBe(40000);

    const feb = await expectSourceMatchesSummary(YEAR, 2);
    const mar = await expectSourceMatchesSummary(YEAR, 3);
    expect(feb.previous_balance).toBe(40000);
    expect(feb.remaining).toBe(40000);
    expect(mar.previous_balance).toBe(40000);
    expect(mar.remaining).toBe(40000);

    const factsAfter = await expectSummaryMatchesSource(YEAR, 2);
    expect(factsAfter).toEqual(factsBefore);
  });

  test("D — deleting an override falls back to the previous month Remaining", async () => {
    await insertIncome(20000, `${YEAR}-01-15`);
    await rebuild(YEAR, 1);
    await upsertPrevious(YEAR, 2, 30000);

    const febOverridden = await buildMonthOverviewFromSummary(userId, YEAR, 2);
    expect(febOverridden.previous_balance).toBe(30000);

    const factsBefore = await expectSummaryMatchesSource(YEAR, 2);

    const deleted = await db.query(
      `DELETE FROM monthly_balances
       WHERE user_id = $1 AND year = $2 AND month = $3
       RETURNING id`,
      [userId, YEAR, 2]
    );
    expect(deleted.rows).toHaveLength(1);

    const jan = await buildMonthOverviewFromSummary(userId, YEAR, 1);
    const feb = await expectSourceMatchesSummary(YEAR, 2);
    const mar = await expectSourceMatchesSummary(YEAR, 3);

    expect(feb.previous_balance).toBe(jan.remaining);
    expect(feb.previous_balance).toBe(20000);
    expect(feb.previous_balance_manual).toBe(false);
    expect(mar.previous_balance).toBe(feb.remaining);

    const factsAfter = await expectSummaryMatchesSource(YEAR, 2);
    expect(factsAfter).toEqual(factsBefore);
  });

  test("E — a later override stops propagation", async () => {
    await insertIncome(10000, `${YEAR}-01-05`);
    await rebuild(YEAR, 1);
    await upsertPrevious(YEAR, 2, 30000);
    await upsertPrevious(YEAR, 4, 1000);

    await upsertPrevious(YEAR, 2, 40000);

    const feb = await expectSourceMatchesSummary(YEAR, 2);
    const mar = await expectSourceMatchesSummary(YEAR, 3);
    const apr = await expectSourceMatchesSummary(YEAR, 4);
    const may = await expectSourceMatchesSummary(YEAR, 5);

    expect(feb.previous_balance).toBe(40000);
    expect(feb.remaining).toBe(40000);
    expect(mar.previous_balance).toBe(40000);
    expect(mar.previous_balance_manual).toBe(false);
    expect(apr.previous_balance).toBe(1000);
    expect(apr.previous_balance_manual).toBe(true);
    expect(apr.previous_balance_calculated).toBe(40000);
    expect(may.previous_balance).toBe(1000);
    expect(may.previous_balance_manual).toBe(false);
    expect(may.remaining).toBe(1000);
  });

  test("F — December Remaining carries into January unless January has an override", async () => {
    await insertIncome(15000, `${YEAR}-12-20`);
    await rebuild(YEAR, 12);

    const december = await expectSourceMatchesSummary(YEAR, 12);
    const januaryOpen = await expectSourceMatchesSummary(YEAR + 1, 1);
    expect(januaryOpen.previous_balance).toBe(december.remaining);
    expect(januaryOpen.previous_balance_manual).toBe(false);
    expect(januaryOpen.remaining).toBe(december.remaining);

    const zero = await upsertPrevious(YEAR + 1, 1, 0);
    expect(zero.status).toBe(200);

    const januaryZero = await expectSourceMatchesSummary(YEAR + 1, 1);
    expect(januaryZero.previous_balance).toBe(0);
    expect(januaryZero.previous_balance_manual).toBe(true);
    expect(januaryZero.previous_balance_calculated).toBe(december.remaining);
    expect(januaryZero.remaining).toBe(0);
  });

  test("upserting an override does not change the 10 summary facts", async () => {
    await insertIncome(8000, `${YEAR}-06-08`);
    await rebuild(YEAR, 6);
    const before = await getMonthlyFinancialSummary(userId, YEAR, 6);

    const updated = await upsertPrevious(YEAR, 6, 1234.5);
    expect(updated.status).toBe(200);

    const after = await getMonthlyFinancialSummary(userId, YEAR, 6);
    expect(factsOf(after)).toEqual(factsOf(before));
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    expect(after.earned).toBe(8000);
    await expectSummaryMatchesSource(YEAR, 6);
  });
});
