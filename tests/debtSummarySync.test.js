require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const seedDebts = require("../src/seed/debts");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const debtRoutes = require("../src/routes/debt.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `dss_${Date.now()}`;
const YEAR = 2022;

let userId;
let otherUserId;
let personId;
let otherPersonId;
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

describe("debt mutation monthly_financial_summary sync", () => {
  beforeAll(async () => {
    await seedDebts();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["DSS Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["DSS Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const person = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, `${SUFFIX}_person`]
    );
    personId = person.rows[0].id;

    const otherPerson = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [otherUserId, `${SUFFIX}_other_person`]
    );
    otherPersonId = otherPerson.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/debts", debtRoutes);

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
  });

  test("create given debt updates given_total", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 10000,
      date: `${YEAR}-01-15`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 1);
    expect(facts.given_total).toBe(10000);
    expect(facts.given_returned).toBe(0);
    expect(facts.received_total).toBe(0);
  });

  test("create received debt updates received_total", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 6000,
      date: `${YEAR}-02-10`,
      user_id: userId,
      person_id: personId,
      debt_type: "received",
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(facts.received_total).toBe(6000);
    expect(facts.given_total).toBe(0);
  });

  test("delete debt restores the origin month", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 4000,
      date: `${YEAR}-03-08`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    expect(
      (await getMonthlyFinancialSummary(userId, YEAR, 3)).given_total
    ).toBe(4000);

    const deleted = await jsonRequest(
      "DELETE",
      `/api/debts/${created.json.data.id}`
    );
    expect(deleted.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(facts.given_total).toBe(0);
    expect(facts.given_returned).toBe(0);
  });

  test("amount update rebuilds the origin month", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 10000,
      date: `${YEAR}-04-12`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/debts/${created.json.data.id}`,
      { amount: 15000 }
    );
    expect(updated.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 4);
    expect(facts.given_total).toBe(15000);
  });

  test("debt_date movement rebuilds old and new origin months", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 9000,
      date: `${YEAR}-05-01`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/debts/${created.json.data.id}`,
      { date: `${YEAR}-06-01` }
    );
    expect(updated.status).toBe(200);

    const may = await expectSummaryMatchesSource(userId, YEAR, 5);
    const june = await expectSummaryMatchesSource(userId, YEAR, 6);
    expect(may.given_total).toBe(0);
    expect(june.given_total).toBe(9000);
  });

  test("changing user_id rebuilds old and new user origin months", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 1750,
      date: `${YEAR}-07-20`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/debts/${created.json.data.id}`,
      {
        user_id: otherUserId,
        person_id: otherPersonId,
      }
    );
    expect(updated.status).toBe(200);

    const oldUser = await expectSummaryMatchesSource(userId, YEAR, 7);
    const newUser = await expectSummaryMatchesSource(otherUserId, YEAR, 7);
    expect(oldUser.given_total).toBe(0);
    expect(newUser.given_total).toBe(1750);
  });

  test("given → received moves origin and return facts", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 10000,
      date: `${YEAR}-08-02`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const debtId = created.json.data.id;
    await jsonRequest("POST", `/api/debts/${debtId}/returns`, {
      amount: 4000,
      date: `${YEAR}-09-05`,
      user_id: userId,
    });

    const updated = await jsonRequest("PATCH", `/api/debts/${debtId}`, {
      debt_type: "received",
    });
    expect(updated.status).toBe(200);

    const august = await expectSummaryMatchesSource(userId, YEAR, 8);
    const september = await expectSummaryMatchesSource(userId, YEAR, 9);
    expect(august.given_total).toBe(0);
    expect(august.received_total).toBe(10000);
    expect(september.given_returned).toBe(0);
    expect(september.received_returned).toBe(4000);
  });

  test("debt return uses return_date month, not parent debt_date month", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 10000,
      date: `${YEAR}-10-10`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const debtId = created.json.data.id;
    await rebuildMonthlyFinancialSummary(userId, YEAR, 11);

    const returned = await jsonRequest("POST", `/api/debts/${debtId}/returns`, {
      amount: 3000,
      date: `${YEAR}-11-05`,
      user_id: userId,
    });
    expect(returned.status).toBe(201);

    const october = await expectSummaryMatchesSource(userId, YEAR, 10);
    const november = await expectSummaryMatchesSource(userId, YEAR, 11);
    expect(october.given_total).toBe(10000);
    expect(october.given_returned).toBe(0);
    expect(november.given_total).toBe(0);
    expect(november.given_returned).toBe(3000);

    const deletedReturn = await jsonRequest(
      "DELETE",
      `/api/debts/${debtId}/returns/${returned.json.data.return.id}`
    );
    expect(deletedReturn.status).toBe(200);

    const novemberAfter = await expectSummaryMatchesSource(userId, YEAR, 11);
    expect(novemberAfter.given_returned).toBe(0);
    const octoberAfter = await expectSummaryMatchesSource(userId, YEAR, 10);
    expect(octoberAfter.given_total).toBe(10000);
  });

  test("received debt return updates received_returned on return_date month", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 5000,
      date: `${YEAR}-01-20`,
      user_id: userId,
      person_id: personId,
      debt_type: "received",
    });
    await jsonRequest("POST", `/api/debts/${created.json.data.id}/returns`, {
      amount: 1200,
      date: `${YEAR}-02-18`,
      user_id: userId,
    });

    const january = await expectSummaryMatchesSource(userId, YEAR, 1);
    const february = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(january.received_total).toBe(5000);
    expect(january.received_returned).toBe(0);
    expect(february.received_returned).toBe(1200);
  });

  test("deleting a debt cascades returns and rebuilds origin plus return months", async () => {
    const created = await jsonRequest("POST", "/api/debts", {
      amount: 10000,
      date: `${YEAR}-12-02`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const debtId = created.json.data.id;

    await jsonRequest("POST", `/api/debts/${debtId}/returns`, {
      amount: 4000,
      date: `${YEAR + 1}-01-10`,
      user_id: userId,
    });
    await jsonRequest("POST", `/api/debts/${debtId}/returns`, {
      amount: 2000,
      date: `${YEAR + 1}-02-10`,
      user_id: userId,
    });

    expect((await expectSummaryMatchesSource(userId, YEAR, 12)).given_total).toBe(
      10000
    );
    expect(
      (await expectSummaryMatchesSource(userId, YEAR + 1, 1)).given_returned
    ).toBe(4000);
    expect(
      (await expectSummaryMatchesSource(userId, YEAR + 1, 2)).given_returned
    ).toBe(2000);

    const deleted = await jsonRequest("DELETE", `/api/debts/${debtId}`);
    expect(deleted.status).toBe(200);

    const remainingReturns = await db.query(
      `SELECT COUNT(*)::int AS c FROM debt_returns WHERE debt_id = $1`,
      [debtId]
    );
    expect(remainingReturns.rows[0].c).toBe(0);

    expect((await expectSummaryMatchesSource(userId, YEAR, 12)).given_total).toBe(
      0
    );
    expect(
      (await expectSummaryMatchesSource(userId, YEAR + 1, 1)).given_returned
    ).toBe(0);
    expect(
      (await expectSummaryMatchesSource(userId, YEAR + 1, 2)).given_returned
    ).toBe(0);
  });

  test("rebuild after mutation is idempotent", async () => {
    await jsonRequest("POST", "/api/debts", {
      amount: 1111,
      date: `${YEAR}-01-28`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    const first = factsOf(await rebuildMonthlyFinancialSummary(userId, YEAR, 1));
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 1)
    );
    expect(second).toEqual(first);
    await expectSummaryMatchesSource(userId, YEAR, 1);
  });
});
