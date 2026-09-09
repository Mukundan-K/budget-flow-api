require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const db = require("../src/db");
const seedPayments = require("../src/seed/payments");
const seedReturns = require("../src/seed/returns");
const seedSavings = require("../src/seed/savings");
const seedDebts = require("../src/seed/debts");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const paymentRoutes = require("../src/routes/payment.routes");
const expenseRoutes = require("../src/routes/expense.routes");
const savingRoutes = require("../src/routes/saving.routes");
const debtRoutes = require("../src/routes/debt.routes");
const overviewRoutes = require("../src/routes/overview.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  rebuildAffectedMonthlyFinancialSummaries,
  compareFacts,
  yearMonthFromTimestamp,
} = require("../src/services/financial/monthlyFinancialSummary.service");
const { getZonedCalendarParts } = require("../src/utils/datetime");

const SUFFIX = `msi_${Date.now()}`;
const YEAR = 2026;

let userId;
let otherUserId;
let incomeTypeId;
let bankAccountId;
let personId;
let server;
let baseUrl;

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

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

async function jsonRequest(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe("monthly summary sync integrity", () => {
  test("payment mutations rebuild inside BEGIN using the same helper", () => {
    const src = readSrc("src/routes/payment.routes.js");
    expect(src).toMatch(/yearMonthFromTimestamp/);
    expect(src.match(/client\.query\("BEGIN"\)/g) || []).toHaveLength(6);
    expect(
      src.match(/rebuildAffectedMonthlyFinancialSummaries/g) || []
    ).toHaveLength(7);
    expect(src).not.toMatch(/UPDATE payment_returns/);
  });

  test("expense mutations rebuild inside BEGIN; split-only uses maybeRebuild", () => {
    const src = readSrc("src/routes/expense.routes.js");
    expect(src).toMatch(/yearMonthFromTimestamp/);
    expect(src).toMatch(/async function maybeRebuildExpenseSummary/);
    expect(src.match(/client\.query\("BEGIN"\)/g) || []).toHaveLength(6);
    expect(src).toMatch(/rebuildAffectedMonthlyFinancialSummaries/);
    expect(src).not.toMatch(/UPDATE expense_returns/);
  });

  test("savings mutations rebuild inside BEGIN", () => {
    const src = readSrc("src/routes/saving.routes.js");
    expect(src).toMatch(/yearMonthFromTimestamp/);
    expect(src.match(/client\.query\("BEGIN"\)/g) || []).toHaveLength(3);
    expect(
      src.match(/rebuildAffectedMonthlyFinancialSummaries/g) || []
    ).toHaveLength(4);
  });

  test("debt mutations rebuild origin and return months inside BEGIN", () => {
    const src = readSrc("src/routes/debt.routes.js");
    expect(src).toMatch(/yearMonthFromTimestamp/);
    expect(src).toMatch(/debtOriginSummaryTarget/);
    expect(src).toMatch(/debtReturnSummaryTarget/);
    expect(src.match(/client\.query\("BEGIN"\)/g) || []).toHaveLength(5);
    expect(src).not.toMatch(/UPDATE debt_returns/);
  });

  test("payment-type classification changes rebuild; balances do not", () => {
    const paymentType = readSrc("src/routes/paymentType.routes.js");
    expect(paymentType).toMatch(/paymentTypeClassificationChanged/);
    expect(paymentType).toMatch(/rebuildAffectedMonthlyFinancialSummaries/);
    const postStart = paymentType.indexOf('router.post("/",');
    const postEnd = paymentType.indexOf("router.get(\"/\"");
    const createHandler = paymentType.slice(postStart, postEnd);
    expect(createHandler).toMatch(/INSERT INTO payment_types/);
    expect(createHandler).not.toMatch(/rebuildAffectedMonthlyFinancialSummaries/);

    const overview = readSrc("src/routes/overview.routes.js");
    expect(overview).toMatch(/INSERT INTO monthly_balances/);
    const balanceFn = overview.slice(
      overview.indexOf("async function updatePreviousBalance")
    );
    expect(balanceFn).not.toMatch(/rebuildAffectedMonthlyFinancialSummaries/);
    expect(balanceFn).not.toMatch(/rebuildMonthlyFinancialSummary/);
  });

  test("rebuildMonthlyFinancialSummary uses the provided client", () => {
    const src = readSrc(
      "src/services/financial/monthlyFinancialSummary.service.js"
    );
    expect(src).toMatch(
      /async function rebuildMonthlyFinancialSummary\(\s*userId,\s*year,\s*month,\s*client = db/
    );
    expect(src).toMatch(/const facts = await computeMonthFacts\(\s*userId,\s*year,\s*month,\s*client/);
    expect(src).toMatch(/lockMonthlyFinancialSummary/);
    expect(src).toMatch(/pg_advisory_xact_lock/);
    expect(src).toMatch(/uniqueSummaryTargets/);
    expect(src).toMatch(/a\.user_id !== b\.user_id/);
  });

  test("yearMonthFromTimestamp uses APP_TIMEZONE, not UTC getters", () => {
    const src = readSrc(
      "src/services/financial/monthlyFinancialSummary.service.js"
    );
    expect(src).toMatch(/getZonedCalendarParts\(new Date\(value\)\)/);
    const helper = src.slice(src.indexOf("function yearMonthFromTimestamp"));
    expect(helper).not.toMatch(/getUTCFullYear/);
    expect(helper).not.toMatch(/getFullYear\(\)/);

    const rangeSrc = readSrc("src/services/financial/monthFacts.query.js");
    expect(rangeSrc).toMatch(/getZonedCalendarParts\(new Date\(value\)\)/);
    expect(rangeSrc).not.toMatch(/getUTCFullYear/);

    const parts = getZonedCalendarParts(new Date("2026-01-01T00:30:00+05:30"));
    const ym = yearMonthFromTimestamp("2026-01-01T00:30:00+05:30");
    expect(ym).toEqual({ year: parts.year, month: parts.month });
    expect(ym).toEqual({ year: 2026, month: 1 });
  });
});

describe("monthly summary sync integrity (live mutations)", () => {
  beforeAll(async () => {
    await seedPayments();
    await seedReturns();
    await seedSavings();
    await seedDebts();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MSI Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MSI Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const income = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'incoming', TRUE)
       RETURNING id`,
      [`${SUFFIX}_income`]
    );
    incomeTypeId = income.rows[0].id;

    const bank = await db.query(
      `INSERT INTO bank_accounts (user_id, name, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [userId, `${SUFFIX}_bank`]
    );
    bankAccountId = bank.rows[0].id;

    const person = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, `${SUFFIX}_person`]
    );
    personId = person.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/payments", paymentRoutes);
    app.use("/api/expenses", expenseRoutes);
    app.use("/api/savings", savingRoutes);
    app.use("/api/debts", debtRoutes);
    app.use("/api/overview", overviewRoutes);

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
    if (incomeTypeId) {
      await db.query(`DELETE FROM payment_types WHERE id = $1`, [incomeTypeId]);
    }
  });

  test("each mutation group rebuilds so summary == computeMonthFacts()", async () => {
    const payment = await jsonRequest("POST", "/api/payments", {
      amount: 5000,
      date: `${YEAR}-03-10`,
      user_id: userId,
      payment_type_id: incomeTypeId,
    });
    expect(payment.status).toBe(201);
    const afterPayment = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(afterPayment.earned).toBe(5000);

    const expense = await jsonRequest("POST", "/api/expenses", {
      amount: 1200,
      expense_date: `${YEAR}-03-12`,
      category: "Home",
      user_id: userId,
    });
    expect(expense.status).toBe(201);
    const afterExpense = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(afterExpense.expenses).toBe(1200);

    const saving = await jsonRequest("POST", "/api/savings", {
      amount: 800,
      date: `${YEAR}-03-14`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    expect(saving.status).toBe(201);
    const afterSaving = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(afterSaving.savings_credited).toBe(800);

    const debt = await jsonRequest("POST", "/api/debts", {
      amount: 3000,
      date: `${YEAR}-03-16`,
      user_id: userId,
      person_id: personId,
      debt_type: "given",
    });
    expect(debt.status).toBe(201);
    const afterDebt = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(afterDebt.given_total).toBe(3000);

    const factsBeforeBalance = await getMonthlyFinancialSummary(
      userId,
      YEAR,
      3
    );
    const balance = await jsonRequest("PUT", "/api/overview/previous-balance", {
      user_id: userId,
      year: YEAR,
      month: 3,
      previous_month_balance: 0,
    });
    expect(balance.status).toBe(200);
    const factsAfterBalance = await getMonthlyFinancialSummary(
      userId,
      YEAR,
      3
    );
    expect(factsOf(factsAfterBalance)).toEqual(factsOf(factsBeforeBalance));
    await expectSummaryMatchesSource(userId, YEAR, 3);
  });

  test("rebuild is idempotent and dedupes identical targets", async () => {
    const first = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 3)
    );
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 3)
    );
    const third = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 3)
    );
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    await rebuildAffectedMonthlyFinancialSummaries(
      [
        { user_id: userId, year: YEAR, month: 3 },
        { user_id: userId, year: YEAR, month: 3 },
        { user_id: otherUserId, year: YEAR, month: 3 },
      ],
      db
    );
    expect(
      factsOf(await getMonthlyFinancialSummary(userId, YEAR, 3))
    ).toEqual(first);
    await expectSummaryMatchesSource(userId, YEAR, 3);
    await expectSummaryMatchesSource(otherUserId, YEAR, 3);
  });
});
