require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  buildMonthOverview,
  buildMonthOverviewFromSource,
  buildMonthOverviewFromSummary,
  buildDashboard,
} = require("../src/routes/overview.routes");
const {
  rebuildMonthlyFinancialSummary,
  currentZonedYearMonth,
} = require("../src/services/financial/monthlyFinancialSummary.service");
const {
  compareOverviews,
} = require("../src/services/financial/monthOverviewCompare");

const SUFFIX = `mor_${Date.now()}`;

let userId;
let incomeTypeId;
let outgoingTypeId;
let bankAccountId;
let personId;

async function rebuild(year, month) {
  return rebuildMonthlyFinancialSummary(userId, year, month);
}

async function insertIncome(amount, date) {
  await db.query(
    `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
     VALUES ($1, $2, $3, $4)`,
    [amount, parseTimestamp(date), userId, incomeTypeId]
  );
}

async function setManualPrevious(year, month, amount) {
  await db.query(
    `INSERT INTO monthly_balances (user_id, month, year, previous_month_balance, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id, month, year)
     DO UPDATE SET
       previous_month_balance = EXCLUDED.previous_month_balance,
       updated_at = NOW()`,
    [userId, month, year, amount]
  );
}

function isIncomingFactSql(sql) {
  return /pt\.flow = 'incoming'/i.test(sql);
}

function isOutgoingFactSql(sql) {
  return /pt\.flow = 'outgoing'/i.test(sql);
}

function isExpenseFactSql(sql) {
  return /FROM expenses e/i.test(sql) && /expense_date >=/i.test(sql);
}

function isSavingsFactSql(sql) {
  return (
    /FROM savings_transactions/i.test(sql) && /transaction_date >=/i.test(sql)
  );
}

async function withQueryLog(work) {
  const original = db.query.bind(db);
  const queries = [];
  db.query = (...args) => {
    queries.push(String(args[0]));
    return original(...args);
  };
  try {
    return await work(queries);
  } finally {
    db.query = original;
  }
}

describe("month overview summary read path", () => {
  beforeAll(async () => {
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["MOR Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const income = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'incoming', TRUE)
       RETURNING id`,
      [`${SUFFIX}_income`]
    );
    incomeTypeId = income.rows[0].id;

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
    if (outgoingTypeId) {
      await db.query(`DELETE FROM payment_types WHERE id = $1`, [outgoingTypeId]);
    }
  });

  test("missing summary row treats all 10 base facts as zero", async () => {
    const inserted = await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [40000, parseTimestamp("2018-03-10"), userId, incomeTypeId]
    );

    const overview = await buildMonthOverviewFromSummary(userId, 2018, 3);
    expect(overview.earned).toBe(0);
    expect(overview.not_earned).toBe(0);
    expect(overview.outgoing_payments_total).toBe(0);
    expect(overview.expense_total).toBe(0);
    expect(overview.savings_amount_saved).toBe(0);
    expect(overview.savings_amount_debited).toBe(0);
    expect(overview.debt_given_total).toBe(0);
    expect(overview.debt_given_returned).toBe(0);
    expect(overview.debt_received_total).toBe(0);
    expect(overview.debt_received_returned).toBe(0);
    expect(overview.incoming).toBe(0);
    expect(overview.remaining).toBe(0);

    const source = await buildMonthOverviewFromSource(userId, 2018, 3);
    expect(source.earned).toBe(40000);
    expect(overview.earned).not.toBe(source.earned);

    await db.query(`DELETE FROM payments WHERE id = $1`, [inserted.rows[0].id]);
  });

  test("empty Feb/Mar carry January Remaining", async () => {
    await insertIncome(20000, "2019-01-15");
    await rebuild(2019, 1);
    await rebuild(2019, 2);
    await rebuild(2019, 3);

    const jan = await buildMonthOverviewFromSummary(userId, 2019, 1);
    const feb = await buildMonthOverviewFromSummary(userId, 2019, 2);
    const mar = await buildMonthOverviewFromSummary(userId, 2019, 3);

    expect(jan.remaining).toBe(20000);
    expect(feb.previous_balance).toBe(20000);
    expect(feb.remaining).toBe(20000);
    expect(feb.earned).toBe(0);
    expect(mar.previous_balance).toBe(20000);
    expect(mar.remaining).toBe(20000);

    const sourceFeb = await buildMonthOverviewFromSource(userId, 2019, 2);
    const sourceMar = await buildMonthOverviewFromSource(userId, 2019, 3);
    expect(compareOverviews(sourceFeb, feb).mismatches).toEqual([]);
    expect(compareOverviews(sourceMar, mar).mismatches).toEqual([]);
  });

  test("February manual previous overrides; March uses February Remaining", async () => {
    await insertIncome(10000, "2019-04-10");
    await rebuild(2019, 4);
    await rebuild(2019, 5);
    await rebuild(2019, 6);

    const april = await buildMonthOverviewFromSummary(userId, 2019, 4);
    await setManualPrevious(2019, 5, 30000);
    const may = await buildMonthOverviewFromSummary(userId, 2019, 5);
    const june = await buildMonthOverviewFromSummary(userId, 2019, 6);

    expect(may.previous_balance).toBe(30000);
    expect(may.previous_balance_manual).toBe(true);
    expect(may.previous_balance_calculated).toBe(april.remaining);
    expect(june.previous_balance).toBe(may.remaining);
    expect(june.previous_balance_manual).toBe(false);

    const sourceMay = await buildMonthOverviewFromSource(userId, 2019, 5);
    const sourceJune = await buildMonthOverviewFromSource(userId, 2019, 6);
    expect(compareOverviews(sourceMay, may).mismatches).toEqual([]);
    expect(compareOverviews(sourceJune, june).mismatches).toEqual([]);
  });

  test("manual previous balance of 0 is a real override", async () => {
    const june = await buildMonthOverviewFromSummary(userId, 2019, 6);
    await insertIncome(8000, "2019-07-08");
    await rebuild(2019, 7);
    await rebuild(2019, 8);
    await setManualPrevious(2019, 8, 0);

    const july = await buildMonthOverviewFromSummary(userId, 2019, 7);
    const august = await buildMonthOverviewFromSummary(userId, 2019, 8);

    expect(july.previous_balance).toBe(june.remaining);
    expect(july.remaining).toBe(june.remaining + 8000);
    expect(august.previous_balance).toBe(0);
    expect(august.previous_balance_manual).toBe(true);
    expect(august.previous_balance_calculated).toBe(july.remaining);
    expect(august.remaining).toBe(0);

    const sourceAug = await buildMonthOverviewFromSource(userId, 2019, 8);
    expect(compareOverviews(sourceAug, august).mismatches).toEqual([]);
  });

  test("December Remaining carries into January of the next year", async () => {
    await insertIncome(15000, "2019-12-20");
    await rebuild(2019, 12);
    await rebuild(2020, 1);

    const december = await buildMonthOverviewFromSummary(userId, 2019, 12);
    const january = await buildMonthOverviewFromSummary(userId, 2020, 1);

    expect(january.previous_balance).toBe(december.remaining);
    expect(january.remaining).toBe(december.remaining);
    expect(january.earned).toBe(0);

    const sourceJan = await buildMonthOverviewFromSource(userId, 2020, 1);
    expect(compareOverviews(sourceJan, january).mismatches).toEqual([]);
  });

  test("month before earliest activity is standalone with previous 0", async () => {
    const overview = await buildMonthOverviewFromSummary(userId, 2017, 6);
    expect(overview.previous_balance).toBe(0);
    expect(overview.earned).toBe(0);
    expect(overview.remaining).toBe(0);

    const source = await buildMonthOverviewFromSource(userId, 2017, 6);
    expect(compareOverviews(source, overview).mismatches).toEqual([]);
  });

  test("current calendar month in APP_TIMEZONE does not throw", async () => {
    const current = currentZonedYearMonth();
    await rebuild(current.year, current.month);
    const overview = await buildMonthOverview(userId, current.year, current.month);
    expect(overview.year).toBe(current.year);
    expect(overview.month).toBe(current.month);
  });

  test("full month overview matches source after rebuild", async () => {
    await db.query(
      `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
       VALUES ($1, $2, $3, $4)`,
      [2500, parseTimestamp("2019-01-22"), userId, outgoingTypeId]
    );
    await db.query(
      `INSERT INTO expenses (amount, expense_type, expense_date, category, user_id)
       VALUES ($1, TRUE, $2, 'Home', $3)`,
      [1200, parseTimestamp("2019-01-18"), userId]
    );
    await db.query(
      `INSERT INTO savings_transactions
         (user_id, bank_account_id, amount, transaction_type, transaction_date)
       VALUES ($1, $2, $3, 'credit', $4)`,
      [userId, bankAccountId, 3000, parseTimestamp("2019-01-19")]
    );
    await db.query(
      `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
       VALUES ($1, $2, $3, 'given', $4)`,
      [userId, personId, 4000, parseTimestamp("2019-01-21")]
    );

    await rebuild(2019, 1);

    const source = await buildMonthOverviewFromSource(userId, 2019, 1);
    const summary = await buildMonthOverviewFromSummary(userId, 2019, 1);
    const compared = compareOverviews(source, summary);
    expect(compared.mismatches).toEqual([]);
    expect(summary.earned).toBe(20000);
    expect(summary.outgoing_payments_total).toBe(2500);
    expect(summary.expense_total).toBe(1200);
    expect(summary.savings_amount_saved).toBe(3000);
    expect(summary.debt_given_total).toBe(4000);
  });

  test("summary read path does not replay historical source fact queries", async () => {
    await insertIncome(5000, "2019-09-05");
    await insertIncome(5000, "2019-10-05");
    await insertIncome(5000, "2019-11-05");
    await rebuild(2019, 9);
    await rebuild(2019, 10);
    await rebuild(2019, 11);

    const sourceQueries = await withQueryLog(async (queries) => {
      await buildMonthOverviewFromSource(userId, 2019, 11);
      return queries;
    });
    const summaryQueries = await withQueryLog(async (queries) => {
      await buildMonthOverviewFromSummary(userId, 2019, 11);
      return queries;
    });

    const sourceIncoming = sourceQueries.filter(isIncomingFactSql).length;
    const summaryIncoming = summaryQueries.filter(isIncomingFactSql).length;
    const summaryOutgoing = summaryQueries.filter(isOutgoingFactSql).length;
    const summaryExpenses = summaryQueries.filter(isExpenseFactSql).length;
    const summarySavings = summaryQueries.filter(isSavingsFactSql).length;
    const summaryTable = summaryQueries.filter((sql) =>
      /FROM monthly_financial_summary/i.test(sql)
    ).length;

    expect(sourceIncoming).toBeGreaterThanOrEqual(3);
    expect(summaryIncoming).toBe(0);
    expect(summaryOutgoing).toBe(0);
    expect(summaryExpenses).toBe(0);
    expect(summarySavings).toBe(0);
    expect(summaryTable).toBeGreaterThanOrEqual(1);
  });

  test("dashboard year remaining is December Remaining", async () => {
    const dashboard = await buildDashboard(userId, 2019, null, "year");
    const december = await buildMonthOverviewFromSummary(userId, 2019, 12);
    const january = await buildMonthOverviewFromSummary(userId, 2019, 1);

    expect(dashboard.balance).toBe(december.remaining);
    expect(dashboard.previous_balance).toBe(january.previous_balance);
    expect(dashboard.filter.mode).toBe("year");
    expect(dashboard.charts.monthly_trend.points).toHaveLength(12);
    expect(dashboard.charts.monthly_trend.series.map((s) => s.key)).not.toContain("debt");
    expect(dashboard.charts.payments_by_type.title).toBe("Payments by Type");
    expect(dashboard.charts.monthly_debt_trend).toBeUndefined();
  });
});
