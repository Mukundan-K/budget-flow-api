require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const seedPayments = require("../src/seed/payments");
const seedReturns = require("../src/seed/returns");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const paymentRoutes = require("../src/routes/payment.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `pss_${Date.now()}`;
const YEAR = 2031;

let userId;
let otherUserId;
let incomeTypeId;
let notEarnedTypeId;
let outgoingTypeId;
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

describe("payment mutation monthly_financial_summary sync", () => {
  beforeAll(async () => {
    await seedPayments();
    await seedReturns();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["PSS Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["PSS Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const income = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'incoming', TRUE)
       RETURNING id`,
      [`${SUFFIX}_income`]
    );
    incomeTypeId = income.rows[0].id;

    const notEarned = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'incoming', FALSE)
       RETURNING id`,
      [`${SUFFIX}_not_earned`]
    );
    notEarnedTypeId = notEarned.rows[0].id;

    const outgoing = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'outgoing', FALSE)
       RETURNING id`,
      [`${SUFFIX}_outgoing`]
    );
    outgoingTypeId = outgoing.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/payments", paymentRoutes);

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
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (otherUserId) {
      await db.query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
    }
    if (incomeTypeId) {
      await db.query(`DELETE FROM payment_types WHERE id = $1`, [incomeTypeId]);
    }
    if (notEarnedTypeId) {
      await db.query(`DELETE FROM payment_types WHERE id = $1`, [
        notEarnedTypeId,
      ]);
    }
    if (outgoingTypeId) {
      await db.query(`DELETE FROM payment_types WHERE id = $1`, [outgoingTypeId]);
    }
  });

  test("create incoming income payment updates earned", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 10000,
      date: `${YEAR}-01-15`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 1);
    expect(facts.earned).toBe(10000);
    expect(facts.not_earned).toBe(0);
    expect(facts.outgoing).toBe(0);
  });

  test("create incoming non-income payment updates not_earned", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 3000,
      date: `${YEAR}-02-10`,
      user_id: userId,
      payment_type_id: notEarnedTypeId,
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(facts.not_earned).toBe(3000);
    expect(facts.earned).toBe(0);
  });

  test("create outgoing payment updates outgoing", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 2500,
      date: `${YEAR}-03-08`,
      user_id: userId,
      payment_type_id: outgoingTypeId,
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(facts.outgoing).toBe(2500);
    expect(facts.expenses).toBe(0);
  });

  test("delete payment restores the month summary", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 4000,
      date: `${YEAR}-04-04`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    expect(created.json.data.earned ?? created.json.data.amount).toBeDefined();
    const paymentId = created.json.data.id;

    await expectSummaryMatchesSource(userId, YEAR, 4);
    const before = await getMonthlyFinancialSummary(userId, YEAR, 4);
    expect(before.earned).toBe(4000);

    const deleted = await jsonRequest("DELETE", `/api/payments/${paymentId}`);
    expect(deleted.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 4);
    expect(facts.earned).toBe(0);
  });

  test("update amount rebuilds the same month once", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 10000,
      date: `${YEAR}-05-12`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    const updated = await jsonRequest("PATCH", `/api/payments/${paymentId}`, {
      amount: 15000,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.data.amount).toBe(15000);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 5);
    expect(facts.earned).toBe(15000);
  });

  test("classification earned → not_earned moves the value", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 8000,
      date: `${YEAR}-06-06`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    const updated = await jsonRequest("PATCH", `/api/payments/${paymentId}`, {
      payment_type_id: notEarnedTypeId,
    });
    expect(updated.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 6);
    expect(facts.earned).toBe(0);
    expect(facts.not_earned).toBe(8000);
  });

  test("classification incoming → outgoing moves the value", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 1200,
      date: `${YEAR}-07-07`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    const updated = await jsonRequest("PATCH", `/api/payments/${paymentId}`, {
      payment_type_id: outgoingTypeId,
    });
    expect(updated.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 7);
    expect(facts.earned).toBe(0);
    expect(facts.outgoing).toBe(1200);
  });

  test("updating payment_date rebuilds old and new months", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 9000,
      date: `${YEAR}-08-01`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    const updated = await jsonRequest("PATCH", `/api/payments/${paymentId}`, {
      date: `${YEAR}-09-01`,
    });
    expect(updated.status).toBe(200);

    const august = await expectSummaryMatchesSource(userId, YEAR, 8);
    const september = await expectSummaryMatchesSource(userId, YEAR, 9);
    expect(august.earned).toBe(0);
    expect(september.earned).toBe(9000);
  });

  test("payment return hits the parent payment month, not return_date month", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 10000,
      date: `${YEAR}-10-10`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    await rebuildMonthlyFinancialSummary(userId, YEAR, 11);
    const marchBefore = await getMonthlyFinancialSummary(userId, YEAR, 11);

    const returned = await jsonRequest(
      "POST",
      `/api/payments/${paymentId}/returns`,
      {
        amount: 3000,
        date: `${YEAR}-11-05`,
        user_id: userId,
      }
    );
    expect(returned.status).toBe(201);

    const october = await expectSummaryMatchesSource(userId, YEAR, 10);
    const november = await expectSummaryMatchesSource(userId, YEAR, 11);
    expect(october.earned).toBe(7000);
    expect(november.earned).toBe(marchBefore.earned);

    const deletedReturn = await jsonRequest(
      "DELETE",
      `/api/payments/${paymentId}/returns/${returned.json.data.return.id}`
    );
    expect(deletedReturn.status).toBe(200);

    const octoberAfter = await expectSummaryMatchesSource(userId, YEAR, 10);
    expect(octoberAfter.earned).toBe(10000);
  });

  test("deleting a payment cascades its return and rebuilds the payment month", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 6000,
      date: `${YEAR}-12-02`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    await jsonRequest("POST", `/api/payments/${paymentId}/returns`, {
      amount: 2000,
      date: `${YEAR + 1}-01-20`,
      user_id: userId,
    });
    const withReturn = await expectSummaryMatchesSource(userId, YEAR, 12);
    expect(withReturn.earned).toBe(4000);

    const deleted = await jsonRequest("DELETE", `/api/payments/${paymentId}`);
    expect(deleted.status).toBe(200);

    const remainingReturns = await db.query(
      `SELECT COUNT(*)::int AS c FROM payment_returns WHERE payment_id = $1`,
      [paymentId]
    );
    expect(remainingReturns.rows[0].c).toBe(0);

    const after = await expectSummaryMatchesSource(userId, YEAR, 12);
    expect(after.earned).toBe(0);
  });

  test("rebuild after mutation is idempotent", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 2222,
      date: `${YEAR}-01-28`,
      user_id: userId,
      payment_type_id: outgoingTypeId,
    });
    expect(created.status).toBe(201);

    const first = factsOf(await rebuildMonthlyFinancialSummary(userId, YEAR, 1));
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 1)
    );
    expect(second).toEqual(first);
    await expectSummaryMatchesSource(userId, YEAR, 1);
  });

  test("changing user_id rebuilds old and new user months", async () => {
    const created = await jsonRequest("POST", "/api/payments", {
      amount: 1750,
      date: `${YEAR}-04-20`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    const paymentId = created.json.data.id;

    const updated = await jsonRequest("PATCH", `/api/payments/${paymentId}`, {
      user_id: otherUserId,
    });
    expect(updated.status).toBe(200);

    const oldUser = await expectSummaryMatchesSource(userId, YEAR, 4);
    const newUser = await expectSummaryMatchesSource(otherUserId, YEAR, 4);
    expect(oldUser.earned).toBe(0);
    expect(newUser.earned).toBe(1750);
  });
});
