require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const seedPayments = require("../src/seed/payments");
const seedReturns = require("../src/seed/returns");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const paymentRoutes = require("../src/routes/payment.routes");
const paymentTypeRoutes = require("../src/routes/paymentType.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `ptss_${Date.now()}`;
const YEAR = 2021;

let userId;
let otherUserId;
let server;
let baseUrl;
let typeCounter = 0;

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

async function createType(flow, isIncome, nameSuffix) {
  typeCounter += 1;
  const created = await jsonRequest("POST", "/api/payment-types", {
    name: `${SUFFIX}_${nameSuffix || typeCounter}`,
    flow,
    is_income: isIncome,
  });
  expect(created.status).toBe(201);
  return created.json.data.id;
}

async function createPayment(uid, typeId, amount, date) {
  const created = await jsonRequest("POST", "/api/payments", {
    amount,
    date,
    user_id: uid,
    payment_type_id: typeId,
  });
  expect(created.status).toBe(201);
  return created.json.data.id;
}

describe("payment type mutation monthly_financial_summary sync", () => {
  beforeAll(async () => {
    await seedPayments();
    await seedReturns();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["PTSS Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["PTSS Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/payments", paymentRoutes);
    app.use("/api/payment-types", paymentTypeRoutes);

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
    await db.query(`DELETE FROM payment_types WHERE name LIKE $1`, [
      `${SUFFIX}%`,
    ]);
  });

  test("creating a payment type does not rebuild existing payment months", async () => {
    const typeId = await createType("incoming", true, "create_existing");
    await createPayment(userId, typeId, 5000, `${YEAR}-01-10`);
    const before = await getMonthlyFinancialSummary(userId, YEAR, 1);

    const created = await jsonRequest("POST", "/api/payment-types", {
      name: `${SUFFIX}_unused_create`,
      flow: "outgoing",
      is_income: false,
    });
    expect(created.status).toBe(201);

    const after = await getMonthlyFinancialSummary(userId, YEAR, 1);
    expect(factsOf(after)).toEqual(factsOf(before));
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    await expectSummaryMatchesSource(userId, YEAR, 1);
  });

  test("PATCH is_income true → false moves earned to not_earned", async () => {
    const typeId = await createType("incoming", true, "income_flip");
    await createPayment(userId, typeId, 8000, `${YEAR}-02-12`);

    const before = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(before.earned).toBe(8000);
    expect(before.not_earned).toBe(0);

    const updated = await jsonRequest("PATCH", `/api/payment-types/${typeId}`, {
      is_income: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.data.flow).toBe("incoming");
    expect(updated.json.data.is_income).toBe(false);

    const after = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(after.earned).toBe(0);
    expect(after.not_earned).toBe(8000);
    expect(after.outgoing).toBe(0);
  });

  test("PUT flow incoming → outgoing moves earned to outgoing", async () => {
    const typeId = await createType("incoming", true, "flow_flip");
    await createPayment(userId, typeId, 1200, `${YEAR}-03-08`);

    const before = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(before.earned).toBe(1200);

    const updated = await jsonRequest("PUT", `/api/payment-types/${typeId}`, {
      name: `${SUFFIX}_flow_flip`,
      flow: "outgoing",
      is_income: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.data.flow).toBe("outgoing");

    const after = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(after.earned).toBe(0);
    expect(after.not_earned).toBe(0);
    expect(after.outgoing).toBe(1200);
  });

  test("multiple payments using the same type are rebuilt together", async () => {
    const typeId = await createType("incoming", true, "multi_pay");
    await createPayment(userId, typeId, 1000, `${YEAR}-04-04`);
    await createPayment(userId, typeId, 2500, `${YEAR}-04-20`);

    const before = await expectSummaryMatchesSource(userId, YEAR, 4);
    expect(before.earned).toBe(3500);

    const updated = await jsonRequest("PATCH", `/api/payment-types/${typeId}`, {
      flow: "outgoing",
    });
    expect(updated.status).toBe(200);

    const after = await expectSummaryMatchesSource(userId, YEAR, 4);
    expect(after.earned).toBe(0);
    expect(after.outgoing).toBe(3500);
  });

  test("same type across months rebuilds each month and leaves unrelated months unchanged", async () => {
    const typeId = await createType("incoming", true, "multi_month");
    const unrelatedTypeId = await createType("outgoing", false, "unrelated");

    await createPayment(userId, typeId, 4000, `${YEAR}-05-05`);
    await createPayment(userId, unrelatedTypeId, 500, `${YEAR}-06-06`);
    await createPayment(userId, typeId, 2000, `${YEAR}-07-07`);

    const juneBefore = await getMonthlyFinancialSummary(userId, YEAR, 6);

    const updated = await jsonRequest("PATCH", `/api/payment-types/${typeId}`, {
      is_income: false,
    });
    expect(updated.status).toBe(200);

    const may = await expectSummaryMatchesSource(userId, YEAR, 5);
    const june = await getMonthlyFinancialSummary(userId, YEAR, 6);
    const july = await expectSummaryMatchesSource(userId, YEAR, 7);
    await expectSummaryMatchesSource(userId, YEAR, 6);

    expect(may.earned).toBe(0);
    expect(may.not_earned).toBe(4000);
    expect(july.earned).toBe(0);
    expect(july.not_earned).toBe(2000);
    expect(factsOf(june).outgoing).toBe(500);
    expect(String(june.updated_at)).toBe(String(juneBefore.updated_at));
  });

  test("same type across users rebuilds each user month", async () => {
    const typeId = await createType("incoming", false, "multi_user");
    await createPayment(userId, typeId, 1750, `${YEAR}-08-08`);
    await createPayment(otherUserId, typeId, 2250, `${YEAR}-09-09`);

    const updated = await jsonRequest("PATCH", `/api/payment-types/${typeId}`, {
      is_income: true,
    });
    expect(updated.status).toBe(200);

    const userFacts = await expectSummaryMatchesSource(userId, YEAR, 8);
    const otherFacts = await expectSummaryMatchesSource(otherUserId, YEAR, 9);
    expect(userFacts.not_earned).toBe(0);
    expect(userFacts.earned).toBe(1750);
    expect(otherFacts.not_earned).toBe(0);
    expect(otherFacts.earned).toBe(2250);
  });

  test("name-only update does not rebuild the monthly summary", async () => {
    const typeId = await createType("incoming", true, "name_only");
    await createPayment(userId, typeId, 3000, `${YEAR}-10-10`);
    const before = await getMonthlyFinancialSummary(userId, YEAR, 10);

    const updated = await jsonRequest("PATCH", `/api/payment-types/${typeId}`, {
      name: `${SUFFIX}_name_only_emi`,
    });
    expect(updated.status).toBe(200);
    expect(updated.json.data.name).toBe(`${SUFFIX}_name_only_emi`);
    expect(updated.json.data.flow).toBe("incoming");
    expect(updated.json.data.is_income).toBe(true);

    const after = await getMonthlyFinancialSummary(userId, YEAR, 10);
    expect(factsOf(after)).toEqual(factsOf(before));
    expect(after.earned).toBe(3000);
    expect(String(after.updated_at)).toBe(String(before.updated_at));
    await expectSummaryMatchesSource(userId, YEAR, 10);
  });

  test("delete is blocked while the type is used and does not change the summary", async () => {
    const typeId = await createType("outgoing", false, "delete_used");
    await createPayment(userId, typeId, 900, `${YEAR}-11-11`);
    const before = await getMonthlyFinancialSummary(userId, YEAR, 11);

    const deleted = await jsonRequest(
      "DELETE",
      `/api/payment-types/${typeId}`
    );
    expect(deleted.status).toBe(409);

    const after = await getMonthlyFinancialSummary(userId, YEAR, 11);
    expect(factsOf(after)).toEqual(factsOf(before));
    expect(after.outgoing).toBe(900);
    await expectSummaryMatchesSource(userId, YEAR, 11);
  });

  test("unused payment type can be deleted without summary rebuild", async () => {
    const typeId = await createType("outgoing", false, "delete_unused");
    const deleted = await jsonRequest(
      "DELETE",
      `/api/payment-types/${typeId}`
    );
    expect(deleted.status).toBe(200);

    const remaining = await db.query(
      `SELECT id FROM payment_types WHERE id = $1`,
      [typeId]
    );
    expect(remaining.rows).toEqual([]);
  });

  test("rebuild after a classification change is idempotent", async () => {
    const typeId = await createType("incoming", true, "idempotent");
    await createPayment(userId, typeId, 2222, `${YEAR}-12-12`);

    const updated = await jsonRequest("PATCH", `/api/payment-types/${typeId}`, {
      flow: "outgoing",
      is_income: false,
    });
    expect(updated.status).toBe(200);

    const first = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 12)
    );
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 12)
    );
    expect(second).toEqual(first);
    expect(first.outgoing).toBe(2222);
    expect(first.earned).toBe(0);
    await expectSummaryMatchesSource(userId, YEAR, 12);
  });
});
