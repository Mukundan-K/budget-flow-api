require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const seedSchema = require("../src/seed/schema");
const seedExpenseSplits = require("../src/seed/expenseSplits");
const seedReturns = require("../src/seed/returns");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const expenseRoutes = require("../src/routes/expense.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `ess_${Date.now()}`;
const YEAR = 2024;

let userId;
let otherUserId;
let server;
let baseUrl;

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
  const rows = compareFacts(current, summary);
  const mismatches = rows.filter((row) => row.difference !== 0);
  expect(mismatches).toEqual([]);
  return factsOf(summary);
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

describe("expense mutation monthly_financial_summary sync", () => {
  beforeAll(async () => {
    await seedSchema();
    await seedExpenseSplits();
    await seedReturns();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ESS Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ESS Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/expenses", expenseRoutes);

    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (userId) {
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [userId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (otherUserId) {
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [otherUserId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
    }
  });

  test("create expense updates summary expenses", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 10000,
      expense_date: `${YEAR}-01-15`,
      user_id: userId,
      category: "Home",
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 1);
    expect(facts.expenses).toBe(10000);
  });

  test("delete expense restores the month summary", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 4000,
      expense_date: `${YEAR}-02-10`,
      user_id: userId,
      category: "Food",
    });
    const expenseId = created.json.data.id;
    expect((await getMonthlyFinancialSummary(userId, YEAR, 2)).expenses).toBe(
      4000
    );

    const deleted = await jsonRequest("DELETE", `/api/expenses/${expenseId}`);
    expect(deleted.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(facts.expenses).toBe(0);
  });

  test("amount update rebuilds the same month", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 10000,
      expense_date: `${YEAR}-03-08`,
      user_id: userId,
      category: "Home",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/expenses/${created.json.data.id}`,
      { amount: 15000 }
    );
    expect(updated.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(facts.expenses).toBe(15000);
  });

  test("date movement rebuilds old and new months", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 9000,
      expense_date: `${YEAR}-04-01`,
      user_id: userId,
      category: "Travel",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/expenses/${created.json.data.id}`,
      { expense_date: `${YEAR}-05-01` }
    );
    expect(updated.status).toBe(200);

    const april = await expectSummaryMatchesSource(userId, YEAR, 4);
    const may = await expectSummaryMatchesSource(userId, YEAR, 5);
    expect(april.expenses).toBe(0);
    expect(may.expenses).toBe(9000);
  });

  test("expense return hits the parent expense month, not return_date month", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 10000,
      expense_date: `${YEAR}-06-10`,
      user_id: userId,
      category: "Home",
    });
    const expenseId = created.json.data.id;

    await rebuildMonthlyFinancialSummary(userId, YEAR, 7);
    const julyBefore = await getMonthlyFinancialSummary(userId, YEAR, 7);

    const returned = await jsonRequest(
      "POST",
      `/api/expenses/${expenseId}/returns`,
      {
        amount: 3000,
        category: "Home",
        date: `${YEAR}-07-05`,
        user_id: userId,
      }
    );
    expect(returned.status).toBe(201);

    const june = await expectSummaryMatchesSource(userId, YEAR, 6);
    const july = await expectSummaryMatchesSource(userId, YEAR, 7);
    expect(june.expenses).toBe(7000);
    expect(july.expenses).toBe(julyBefore.expenses);

    const deletedReturn = await jsonRequest(
      "DELETE",
      `/api/expenses/${expenseId}/returns/${returned.json.data.return.id}`
    );
    expect(deletedReturn.status).toBe(200);

    const juneAfter = await expectSummaryMatchesSource(userId, YEAR, 6);
    expect(juneAfter.expenses).toBe(10000);
  });

  test("deleting an expense cascades returns and rebuilds the expense month", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 6000,
      expense_date: `${YEAR}-08-02`,
      user_id: userId,
      category: "Home",
    });
    const expenseId = created.json.data.id;

    await jsonRequest("POST", `/api/expenses/${expenseId}/returns`, {
      amount: 2000,
      category: "Home",
      date: `${YEAR}-09-20`,
      user_id: userId,
    });
    expect((await expectSummaryMatchesSource(userId, YEAR, 8)).expenses).toBe(
      4000
    );

    const deleted = await jsonRequest("DELETE", `/api/expenses/${expenseId}`);
    expect(deleted.status).toBe(200);

    const remainingReturns = await db.query(
      `SELECT COUNT(*)::int AS c FROM expense_returns WHERE expense_id = $1`,
      [expenseId]
    );
    expect(remainingReturns.rows[0].c).toBe(0);

    const after = await expectSummaryMatchesSource(userId, YEAR, 8);
    expect(after.expenses).toBe(0);
  });

  test("changing user_id rebuilds old and new user months", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 1750,
      expense_date: `${YEAR}-10-20`,
      user_id: userId,
      category: "Home",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/expenses/${created.json.data.id}`,
      { user_id: otherUserId }
    );
    expect(updated.status).toBe(200);

    const oldUser = await expectSummaryMatchesSource(userId, YEAR, 10);
    const newUser = await expectSummaryMatchesSource(otherUserId, YEAR, 10);
    expect(oldUser.expenses).toBe(0);
    expect(newUser.expenses).toBe(1750);
  });

  test("split-only change does not rebuild summary expenses", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 10000,
      expense_date: `${YEAR}-11-11`,
      user_id: userId,
      category: "Home",
    });
    const expenseId = created.json.data.id;
    const before = await getMonthlyFinancialSummary(userId, YEAR, 11);
    expect(before.expenses).toBe(10000);

    const updated = await jsonRequest("PATCH", `/api/expenses/${expenseId}`, {
      category: "Travel",
      expense_type: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.data.category).toBe("Travel");
    expect(updated.json.data.expense_type).toBe(false);

    const after = await getMonthlyFinancialSummary(userId, YEAR, 11);
    expect(after.expenses).toBe(10000);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    await expectSummaryMatchesSource(userId, YEAR, 11);

    const pie = await jsonRequest(
      "GET",
      `/api/expenses/pie-chart?user_id=${userId}&filter=month&month=11&year=${YEAR}`
    );
    expect(pie.status).toBe(200);
    const travelSlice = pie.json.data.by_category.slices.find(
      (slice) => slice.category === "Travel"
    );
    expect(travelSlice).toBeDefined();
    expect(travelSlice.total).toBe(10000);
  });

  test("removing a split category that had returns rebuilds expenses", async () => {
    const created = await jsonRequest("POST", "/api/expenses", {
      amount: 10000,
      expense_date: `${YEAR}-12-12`,
      user_id: userId,
      categories: [
        { category: "Food", amount: 6000, expense_type: true },
        { category: "Fun", amount: 4000, expense_type: false },
      ],
    });
    const expenseId = created.json.data.id;

    await jsonRequest("POST", `/api/expenses/${expenseId}/returns`, {
      amount: 1500,
      category: "Food",
      date: `${YEAR + 1}-01-03`,
      user_id: userId,
    });
    expect((await expectSummaryMatchesSource(userId, YEAR, 12)).expenses).toBe(
      8500
    );

    const updated = await jsonRequest("PATCH", `/api/expenses/${expenseId}`, {
      amount: 10000,
      categories: [{ category: "Fun", amount: 10000, expense_type: false }],
    });
    expect(updated.status).toBe(200);

    const after = await expectSummaryMatchesSource(userId, YEAR, 12);
    expect(after.expenses).toBe(10000);
  });

  test("rebuild after mutation is idempotent", async () => {
    await jsonRequest("POST", "/api/expenses", {
      amount: 2222,
      expense_date: `${YEAR}-01-28`,
      user_id: userId,
      category: "Home",
    });
    const first = factsOf(await rebuildMonthlyFinancialSummary(userId, YEAR, 1));
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 1)
    );
    expect(second).toEqual(first);
    await expectSummaryMatchesSource(userId, YEAR, 1);
  });
});
