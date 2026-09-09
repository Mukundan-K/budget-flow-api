require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  FACT_FIELDS,
  EMPTY_FACTS,
  computeMonthFacts,
  rebuildMonthlyFinancialSummary,
  getMonthlyFinancialSummary,
  compareFacts,
} = require("../src/services/financial/monthlyFinancialSummary.service");

const SUFFIX = `mfs_${Date.now()}`;

let userId;
let incomeTypeId;
let notEarnedTypeId;
let outgoingTypeId;
let bankAccountId;
let personId;

function factsOf(row) {
  const facts = {};
  FACT_FIELDS.forEach((field) => {
    facts[field] = row[field];
  });
  return facts;
}

async function rebuild(year, month) {
  return rebuildMonthlyFinancialSummary(userId, year, month);
}

describe("monthly_financial_summary rebuild", () => {
  beforeAll(async () => {
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MFS Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

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
  });

  afterAll(async () => {
    if (userId) {
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [userId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
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

  test("empty month stores all 10 values as 0", async () => {
    const row = await rebuild(2020, 1);
    expect(factsOf(row)).toEqual(EMPTY_FACTS);
    const stored = await getMonthlyFinancialSummary(userId, 2020, 1);
    expect(factsOf(stored)).toEqual(EMPTY_FACTS);
  });

  test("incoming + is_income=true → earned", async () => {
    await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)`,
      [50000, parseTimestamp("2026-01-15"), userId, incomeTypeId]
    );
    const row = await rebuild(2026, 1);
    expect(row.earned).toBe(50000);
    expect(row.not_earned).toBe(0);
    expect(row.outgoing).toBe(0);
  });

  test("incoming + is_income=false → not_earned", async () => {
    await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)`,
      [3000, parseTimestamp("2026-01-16"), userId, notEarnedTypeId]
    );
    const row = await rebuild(2026, 1);
    expect(row.earned).toBe(50000);
    expect(row.not_earned).toBe(3000);
  });

  test("outgoing flow → outgoing", async () => {
    await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)`,
      [8000, parseTimestamp("2026-01-20"), userId, outgoingTypeId]
    );
    const row = await rebuild(2026, 1);
    expect(row.outgoing).toBe(8000);
  });

  test("payment return in March reduces January earned, not March", async () => {
    const payment = await db.query(
      `SELECT id FROM payments
       WHERE user_id = $1 AND payment_type_id = $2
       ORDER BY id ASC
       LIMIT 1`,
      [userId, incomeTypeId]
    );
    await db.query(
      `INSERT INTO payment_returns (payment_id, user_id, amount, return_date)
       VALUES ($1, $2, $3, $4)`,
      [payment.rows[0].id, userId, 2000, parseTimestamp("2026-03-05")]
    );

    const january = await rebuild(2026, 1);
    const march = await rebuild(2026, 3);
    expect(january.earned).toBe(48000);
    expect(march.earned).toBe(0);
    expect(march.not_earned).toBe(0);
    expect(march.outgoing).toBe(0);
  });

  test("expense header net uses expense month; March return hits January", async () => {
    const expense = await db.query(
      `INSERT INTO expenses (amount, expense_type, expense_date, category, user_id)
       VALUES ($1, TRUE, $2, 'Home', $3)
       RETURNING id`,
      [10000, parseTimestamp("2026-01-12"), userId]
    );
    await db.query(
      `INSERT INTO expense_returns (expense_id, category, user_id, amount, return_date)
       VALUES ($1, 'Home', $2, $3, $4)`,
      [expense.rows[0].id, userId, 1500, parseTimestamp("2026-03-08")]
    );

    const january = await rebuild(2026, 1);
    const march = await rebuild(2026, 3);
    expect(january.expenses).toBe(8500);
    expect(march.expenses).toBe(0);
  });

  test("savings credit and debit are separate fields", async () => {
    await db.query(
      `INSERT INTO savings_transactions
         (user_id, bank_account_id, amount, transaction_type, transaction_date)
       VALUES ($1, $2, $3, 'credit', $4), ($1, $2, $5, 'debit', $4)`,
      [userId, bankAccountId, 4000, parseTimestamp("2026-01-25"), 1000]
    );
    const row = await rebuild(2026, 1);
    expect(row.savings_credited).toBe(4000);
    expect(row.savings_debited).toBe(1000);
  });

  test("given debt uses debt_date; return uses return_date", async () => {
    const debt = await db.query(
      `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
       VALUES ($1, $2, $3, 'given', $4)
       RETURNING id`,
      [userId, personId, 10000, parseTimestamp("2026-01-10")]
    );
    await db.query(
      `INSERT INTO debt_returns (debt_id, user_id, amount, return_date)
       VALUES ($1, $2, $3, $4)`,
      [debt.rows[0].id, userId, 4000, parseTimestamp("2026-03-05")]
    );

    const january = await rebuild(2026, 1);
    const march = await rebuild(2026, 3);
    expect(january.given_total).toBe(10000);
    expect(january.given_returned).toBe(0);
    expect(march.given_total).toBe(0);
    expect(march.given_returned).toBe(4000);
  });

  test("received debt uses debt_date; repayment uses return_date", async () => {
    const debt = await db.query(
      `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
       VALUES ($1, $2, $3, 'received', $4)
       RETURNING id`,
      [userId, personId, 6000, parseTimestamp("2026-01-11")]
    );
    await db.query(
      `INSERT INTO debt_returns (debt_id, user_id, amount, return_date)
       VALUES ($1, $2, $3, $4)`,
      [debt.rows[0].id, userId, 2000, parseTimestamp("2026-03-06")]
    );

    const january = await rebuild(2026, 1);
    const march = await rebuild(2026, 3);
    expect(january.received_total).toBe(6000);
    expect(january.received_returned).toBe(0);
    expect(march.received_total).toBe(0);
    expect(march.received_returned).toBe(2000);
  });

  test("rebuild is idempotent", async () => {
    const first = factsOf(await rebuild(2026, 1));
    const second = factsOf(await rebuild(2026, 1));
    expect(second).toEqual(first);
    const count = await db.query(
      `SELECT COUNT(*)::int AS c
       FROM monthly_financial_summary
       WHERE user_id = $1 AND year = 2026 AND month = 1`,
      [userId]
    );
    expect(count.rows[0].c).toBe(1);
  });

  test("moving a January outgoing payment to February updates both months", async () => {
    const inserted = await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [2500, parseTimestamp("2026-01-28"), userId, outgoingTypeId]
    );

    const januaryBefore = await rebuild(2026, 1);
    await rebuild(2026, 2);
    expect(januaryBefore.outgoing).toBe(10500);

    await db.query(`UPDATE payments SET payment_date = $1 WHERE id = $2`, [
      parseTimestamp("2026-02-02"),
      inserted.rows[0].id,
    ]);

    const januaryAfter = await rebuild(2026, 1);
    const februaryAfter = await rebuild(2026, 2);
    expect(januaryAfter.outgoing).toBe(8000);
    expect(februaryAfter.outgoing).toBe(2500);
  });

  test("stored summary matches current Remaining source queries", async () => {
    const current = await computeMonthFacts(userId, 2026, 1);
    const summary = await getMonthlyFinancialSummary(userId, 2026, 1);
    const rows = compareFacts(current, summary);
    rows.forEach((row) => {
      expect(row.difference).toBe(0);
    });
  });
});
