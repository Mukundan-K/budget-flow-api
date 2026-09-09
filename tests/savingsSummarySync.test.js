require("dotenv").config();

const express = require("express");
const db = require("../src/db");
const seedSavings = require("../src/seed/savings");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const savingRoutes = require("../src/routes/saving.routes");
const {
  buildMonthOverviewFromSummary,
} = require("../src/routes/overview.routes");
const {
  FACT_FIELDS,
  computeMonthFacts,
  getMonthlyFinancialSummary,
  rebuildMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `sss_${Date.now()}`;
const YEAR = 2023;

let userId;
let otherUserId;
let bankAccountId;
let otherBankAccountId;
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

describe("savings mutation monthly_financial_summary sync", () => {
  beforeAll(async () => {
    await seedSavings();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["SSS Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["SSS Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const bank = await db.query(
      `INSERT INTO bank_accounts (user_id, name, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [userId, `${SUFFIX}_bank`]
    );
    bankAccountId = bank.rows[0].id;

    const otherBank = await db.query(
      `INSERT INTO bank_accounts (user_id, name, is_active)
       VALUES ($1, $2, TRUE)
       RETURNING id`,
      [otherUserId, `${SUFFIX}_other_bank`]
    );
    otherBankAccountId = otherBank.rows[0].id;

    const app = express();
    app.use(express.json());
    app.use("/api/savings", savingRoutes);

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

  test("create credit updates savings_credited", async () => {
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 10000,
      date: `${YEAR}-01-15`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 1);
    expect(facts.savings_credited).toBe(10000);
    expect(facts.savings_debited).toBe(0);
  });

  test("create debit updates savings_debited", async () => {
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 2500,
      date: `${YEAR}-02-10`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "debit",
    });
    expect(created.status).toBe(201);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 2);
    expect(facts.savings_credited).toBe(0);
    expect(facts.savings_debited).toBe(2500);
  });

  test("delete savings transaction restores the month and empty month is zero", async () => {
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 4000,
      date: `${YEAR}-03-08`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    const savingId = created.json.data.id;
    expect(
      (await getMonthlyFinancialSummary(userId, YEAR, 3)).savings_credited
    ).toBe(4000);

    const deleted = await jsonRequest("DELETE", `/api/savings/${savingId}`);
    expect(deleted.status).toBe(200);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 3);
    expect(facts.savings_credited).toBe(0);
    expect(facts.savings_debited).toBe(0);
  });

  test("amount update rebuilds the same month", async () => {
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 10000,
      date: `${YEAR}-04-12`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/savings/${created.json.data.id}`,
      { amount: 15000 }
    );
    expect(updated.status).toBe(200);
    expect(updated.json.data.amount).toBe(15000);

    const facts = await expectSummaryMatchesSource(userId, YEAR, 4);
    expect(facts.savings_credited).toBe(15000);
  });

  test("date movement rebuilds old and new months", async () => {
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 9000,
      date: `${YEAR}-05-01`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/savings/${created.json.data.id}`,
      { date: `${YEAR}-06-01` }
    );
    expect(updated.status).toBe(200);

    const may = await expectSummaryMatchesSource(userId, YEAR, 5);
    const june = await expectSummaryMatchesSource(userId, YEAR, 6);
    expect(may.savings_credited).toBe(0);
    expect(june.savings_credited).toBe(9000);
  });

  test("credit → debit moves the value between summary fields", async () => {
    await jsonRequest("POST", "/api/savings", {
      amount: 20000,
      date: `${YEAR}-07-02`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 8000,
      date: `${YEAR}-07-03`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });

    const updated = await jsonRequest(
      "PATCH",
      `/api/savings/${created.json.data.id}`,
      { transaction_type: "debit" }
    );
    expect(updated.status).toBe(200);
    expect(updated.json.data.transaction_type).toBe("debit");

    const facts = await expectSummaryMatchesSource(userId, YEAR, 7);
    expect(facts.savings_credited).toBe(20000);
    expect(facts.savings_debited).toBe(8000);
  });

  test("changing user_id rebuilds old and new user months", async () => {
    const created = await jsonRequest("POST", "/api/savings", {
      amount: 1750,
      date: `${YEAR}-08-20`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    const updated = await jsonRequest(
      "PATCH",
      `/api/savings/${created.json.data.id}`,
      {
        user_id: otherUserId,
        bank_account_id: otherBankAccountId,
      }
    );
    expect(updated.status).toBe(200);

    const oldUser = await expectSummaryMatchesSource(userId, YEAR, 8);
    const newUser = await expectSummaryMatchesSource(otherUserId, YEAR, 8);
    expect(oldUser.savings_credited).toBe(0);
    expect(newUser.savings_credited).toBe(1750);
  });

  test("dashboard month overview uses rebuilt savings facts for Remaining", async () => {
    const createdCredit = await jsonRequest("POST", "/api/savings", {
      amount: 7000,
      date: `${YEAR}-10-10`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    expect(createdCredit.status).toBe(201);
    await jsonRequest("POST", "/api/savings", {
      amount: 2000,
      date: `${YEAR}-10-11`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "debit",
    });

    const facts = await expectSummaryMatchesSource(userId, YEAR, 10);
    expect(facts.savings_credited).toBe(7000);
    expect(facts.savings_debited).toBe(2000);

    const overview = await buildMonthOverviewFromSummary(userId, YEAR, 10);
    expect(overview.savings_amount_saved).toBe(7000);
    expect(overview.savings_amount_debited).toBe(2000);
    expect(overview.from_savings).toBe(5000);
    expect(overview.remaining).toBe(overview.incoming + overview.previous_balance - overview.spent - overview.from_savings - overview.debt);
  });

  test("rebuild after mutation is idempotent", async () => {
    await jsonRequest("POST", "/api/savings", {
      amount: 1111,
      date: `${YEAR}-01-28`,
      user_id: userId,
      bank_account_id: bankAccountId,
      transaction_type: "credit",
    });
    const first = factsOf(await rebuildMonthlyFinancialSummary(userId, YEAR, 1));
    const second = factsOf(
      await rebuildMonthlyFinancialSummary(userId, YEAR, 1)
    );
    expect(second).toEqual(first);
    await expectSummaryMatchesSource(userId, YEAR, 1);
  });

  test("lifetime savings details remain source-based", async () => {
    const details = await jsonRequest(
      "GET",
      `/api/savings/details?user_id=${userId}`
    );
    expect(details.status).toBe(200);
    expect(details.json.data.available_balance).toBeGreaterThan(0);
    const bank = details.json.data.bank_accounts.find(
      (item) => item.id === bankAccountId
    );
    expect(bank.available_balance).toBe(bank.net);
  });
});
