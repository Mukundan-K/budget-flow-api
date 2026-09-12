require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedSchema = require("../src/seed/schema");
const seedExpenseSplits = require("../src/seed/expenseSplits");
const seedReturns = require("../src/seed/returns");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  buildDashboard,
  getExpenseTypeNetsForMonth,
  getExpenseTypeNetsForYear,
} = require("../src/routes/overview.routes");
const {
  installQueryProfile,
  resetQueryProfile,
  getQueryProfile,
} = require("../src/utils/queryProfile");

const SUFFIX = `etn_${Date.now()}`;
const YEAR = 2026;

let userId;
let otherUserId;

async function insertExpense({
  uid,
  amount,
  date,
  category = "Home",
  expenseType = true,
  splits,
  returns,
}) {
  const inserted = await db.query(
    `INSERT INTO expenses (amount, expense_type, expense_date, category, user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [amount, expenseType, parseTimestamp(date), category, uid]
  );
  const id = inserted.rows[0].id;

  if (splits && splits.length) {
    for (let i = 0; i < splits.length; i++) {
      const split = splits[i];
      await db.query(
        `INSERT INTO expense_category_splits
           (expense_id, category, amount, expense_type, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, split.category, split.amount, split.expenseType, i]
      );
    }
  }

  if (returns && returns.length) {
    for (const ret of returns) {
      await db.query(
        `INSERT INTO expense_returns
           (expense_id, category, user_id, amount, return_date)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          id,
          ret.category || category,
          uid,
          ret.amount,
          parseTimestamp(ret.date || date),
        ]
      );
    }
  }

  return id;
}

async function monthlyNets(uid, year) {
  const months = [];
  for (let month = 1; month <= 12; month++) {
    const nets = await getExpenseTypeNetsForMonth(uid, year, month);
    months.push({ month, year, ...nets });
  }
  return months;
}

function profileCount(profile, name) {
  return profile.byName.find((row) => row.name === name)?.count || 0;
}

/**
 * Current dashboard SQL contract (month or year mode):
 * - one combined expense-charts query (not polar + type-net helpers)
 * - summary facts, not per-month source facts
 * - selected-month live overlay: salary date, EMI stats, debt repaid split
 * - EMI overview: products + period payments + paid-months before/through
 * Total 13 queries for a year that already has activity.
 */
function expectDashboardQueryContract(profile) {
  expect(profileCount(profile, "expense_charts")).toBe(1);
  expect(profileCount(profile, "category_polar")).toBe(0);
  expect(profileCount(profile, "expense_type_nets")).toBe(0);
  expect(profileCount(profile, "expense_type_nets_year")).toBe(0);
  expect(profile.sourceFactQueries).toBe(0);
  expect(profileCount(profile, "monthly_financial_summary")).toBe(1);
  expect(profileCount(profile, "monthly_balances")).toBe(1);
  expect(profileCount(profile, "activity_range")).toBe(1);
  expect(profileCount(profile, "outgoing_payment_groups")).toBe(1);
  expect(profileCount(profile, "payment_type_groups")).toBe(1);
  expect(profileCount(profile, "monthly_debt_trend_opening")).toBe(0);
  expect(profileCount(profile, "monthly_debt_trend")).toBe(0);
  expect(profileCount(profile, "latest_salary")).toBe(1);
  expect(profileCount(profile, "emi_stats")).toBe(1);
  expect(profileCount(profile, "debt_originated")).toBe(1);
  expect(profileCount(profile, "emi_products")).toBe(1);
  expect(profileCount(profile, "emi_period_payments")).toBe(1);
  expect(profileCount(profile, "emi_paid_months")).toBe(2);
  expect(profile.queryCount).toBe(13);
}

describe("getExpenseTypeNetsForYear matches 12 monthly queries", () => {
  beforeAll(async () => {
    await seedSchema();
    await seedExpenseSplits();
    await seedReturns();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ETN Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ETN Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    await insertExpense({
      uid: userId,
      amount: 1000.5,
      date: `${YEAR}-01-15`,
      category: "Food",
      expenseType: true,
    });
    await insertExpense({
      uid: userId,
      amount: 250,
      date: `${YEAR}-03-08`,
      category: "Fun",
      expenseType: false,
    });
    await insertExpense({
      uid: userId,
      amount: 80.25,
      date: `${YEAR}-03-20`,
      category: "Snacks",
      expenseType: false,
    });
    await insertExpense({
      uid: userId,
      amount: 400,
      date: `${YEAR}-05-04`,
      category: "Mixed",
      expenseType: true,
      splits: [
        { category: "Rent", amount: 250, expenseType: true },
        { category: "Games", amount: 150, expenseType: false },
      ],
    });
    await insertExpense({
      uid: userId,
      amount: 300,
      date: `${YEAR}-08-12`,
      category: "Travel",
      expenseType: true,
      returns: [{ amount: 40.5, category: "Travel", date: `${YEAR}-09-01` }],
    });
    await insertExpense({
      uid: userId,
      amount: 500,
      date: `${YEAR}-12-31`,
      category: "Gifts",
      expenseType: false,
    });
    await insertExpense({
      uid: userId,
      amount: 999,
      date: `${YEAR + 1}-01-01`,
      category: "NextYear",
      expenseType: true,
    });
    await insertExpense({
      uid: otherUserId,
      amount: 777,
      date: `${YEAR}-03-10`,
      category: "OtherUser",
      expenseType: false,
    });
  });

  afterAll(async () => {
    if (userId) {
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [userId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    if (otherUserId) {
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [otherUserId]);
      await db.query(`DELETE FROM users WHERE id = $1`, [otherUserId]);
    }
  });

  test("every month 1–12 matches getExpenseTypeNetsForMonth", async () => {
    const yearly = await getExpenseTypeNetsForYear(userId, YEAR);
    const monthly = await monthlyNets(userId, YEAR);
    expect(yearly).toHaveLength(12);
    expect(yearly).toEqual(monthly);
  });

  test("empty months are zero; sparse months keep their nets", async () => {
    const yearly = await getExpenseTypeNetsForYear(userId, YEAR);
    expect(yearly[1]).toEqual({
      month: 2,
      year: YEAR,
      necessary: 0,
      unnecessary: 0,
    });
    expect(yearly[0].necessary).toBe(1000.5);
    expect(yearly[0].unnecessary).toBe(0);
    expect(yearly[2].necessary).toBe(0);
    expect(yearly[2].unnecessary).toBe(330.25);
  });

  test("splits and returns follow the monthly helper", async () => {
    const yearly = await getExpenseTypeNetsForYear(userId, YEAR);
    expect(yearly[4].necessary).toBe(250);
    expect(yearly[4].unnecessary).toBe(150);
    expect(yearly[7].necessary).toBe(259.5);
    expect(yearly[7].unnecessary).toBe(0);
  });

  test("does not include other users or the next calendar year", async () => {
    const yearly = await getExpenseTypeNetsForYear(userId, YEAR);
    const otherMarch = await getExpenseTypeNetsForMonth(otherUserId, YEAR, 3);
    expect(otherMarch.unnecessary).toBe(777);
    expect(yearly[2].unnecessary).toBe(330.25);
    expect(yearly[11].unnecessary).toBe(500);
    const nextJan = await getExpenseTypeNetsForMonth(userId, YEAR + 1, 1);
    expect(nextJan.necessary).toBe(999);
    const thisJan = yearly[0];
    expect(thisJan.necessary).toBe(1000.5);
  });

  test("year dashboard expense-type totals match the 12 monthly queries", async () => {
    const monthly = await monthlyNets(userId, YEAR);
    const expectedNecessary = monthly.reduce((sum, row) => sum + row.necessary, 0);
    const expectedUnnecessary = monthly.reduce(
      (sum, row) => sum + row.unnecessary,
      0
    );

    const dashboard = await buildDashboard(userId, YEAR, null, "year");
    expect(dashboard.necessary).toBe(expectedNecessary);
    expect(dashboard.unnecessary).toBe(expectedUnnecessary);
    expect(dashboard.charts.expense_type.slices.find((s) => s.key === "necessary").total).toBe(
      expectedNecessary
    );
    expect(
      dashboard.charts.expense_type.slices.find((s) => s.key === "unnecessary").total
    ).toBe(expectedUnnecessary);
    dashboard.charts.monthly_trend.points.forEach((point) => {
      const monthNets = monthly[point.month - 1];
      expect(point.necessary).toBe(monthNets.necessary);
      expect(point.unnecessary).toBe(monthNets.unnecessary);
    });
  });

  test("year dashboard issues one combined expense-chart query and the current dashboard read set", async () => {
    const stop = installQueryProfile(db);
    try {
      resetQueryProfile();
      await buildDashboard(userId, YEAR, null, "year");
      const profile = getQueryProfile();
      const monthlyType = profile.byName.find(
        (row) => row.name === "expense_type_nets"
      );
      const yearType = profile.byName.find(
        (row) => row.name === "expense_type_nets_year"
      );
      expect(monthlyType).toBeUndefined();
      expect(yearType).toBeUndefined();
      const combined = profile.byName.find((row) => row.name === "expense_charts");
      const polar = profile.byName.find((row) => row.name === "category_polar");
      expect(polar).toBeUndefined();
      expect(combined).toEqual(
        expect.objectContaining({ name: "expense_charts", count: 1 })
      );
      expectDashboardQueryContract(profile);
    } finally {
      stop();
    }
  });

  test("month dashboard uses one combined expense-chart query and the current dashboard read set", async () => {
    const stop = installQueryProfile(db);
    try {
      resetQueryProfile();
      await buildDashboard(userId, YEAR, 3, "month");
      const profile = getQueryProfile();
      const monthlyType = profile.byName.find(
        (row) => row.name === "expense_type_nets"
      );
      const yearType = profile.byName.find(
        (row) => row.name === "expense_type_nets_year"
      );
      const polar = profile.byName.find((row) => row.name === "category_polar");
      const combined = profile.byName.find((row) => row.name === "expense_charts");
      expect(yearType).toBeUndefined();
      expect(monthlyType).toBeUndefined();
      expect(polar).toBeUndefined();
      expect(combined.count).toBe(1);
      expectDashboardQueryContract(profile);
    } finally {
      stop();
    }
  });
});
