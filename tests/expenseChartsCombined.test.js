require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp, monthRangeTimestamps } = require("../src/utils/datetime");
const seedSchema = require("../src/seed/schema");
const seedExpenseSplits = require("../src/seed/expenseSplits");
const seedReturns = require("../src/seed/returns");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  buildDashboard,
  getCategoryPolarArea,
  getExpenseTypeNetsForMonth,
  getExpenseTypeNetsForYear,
  getExpenseChartsForMonth,
  getExpenseChartsForYear,
} = require("../src/routes/overview.routes");
const {
  installQueryProfile,
  resetQueryProfile,
  getQueryProfile,
} = require("../src/utils/queryProfile");

const SUFFIX = `ech_${Date.now()}`;
const YEAR = 2026;

let userId;
let otherUserId;
let emptyUserId;

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

function yearRange(year) {
  const jan = monthRangeTimestamps(year, 1);
  const dec = monthRangeTimestamps(year, 12);
  return { start: jan.start, end: dec.end };
}

async function oldMonthPair(uid, year, month) {
  const { start, end } = monthRangeTimestamps(year, month);
  return {
    polar_area: await getCategoryPolarArea(uid, start, end),
    typeNets: await getExpenseTypeNetsForMonth(uid, year, month),
  };
}

async function oldYearPair(uid, year) {
  const { start, end } = yearRange(year);
  return {
    polar_area: await getCategoryPolarArea(uid, start, end),
    typeNetsByMonth: await getExpenseTypeNetsForYear(uid, year),
  };
}

function profileCount(profile, name) {
  return profile.byName.find((row) => row.name === name)?.count || 0;
}

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

describe("combined expense charts match polar + type-net helpers", () => {
  beforeAll(async () => {
    await seedSchema();
    await seedExpenseSplits();
    await seedReturns();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ECH Test", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const other = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ECH Other", `${SUFFIX}_other@example.com`, `${SUFFIX}_other`]
    );
    otherUserId = other.rows[0].id;

    const empty = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["ECH Empty", `${SUFFIX}_empty@example.com`, `${SUFFIX}_empty`]
    );
    emptyUserId = empty.rows[0].id;

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
      returns: [
        { amount: 20.25, category: "Travel", date: `${YEAR}-08-15` },
        { amount: 20.25, category: "Travel", date: `${YEAR}-09-01` },
      ],
    });
    await insertExpense({
      uid: userId,
      amount: 500,
      date: `${YEAR}-10-10`,
      category: "SplitReturn",
      expenseType: true,
      splits: [
        { category: "Tickets", amount: 300.4, expenseType: true },
        { category: "Hotels", amount: 199.6, expenseType: false },
      ],
      returns: [
        { amount: 50.4, category: "Tickets", date: `${YEAR}-11-01` },
        { amount: 10, category: "Hotels", date: `${YEAR}-11-02` },
      ],
    });
    await insertExpense({
      uid: userId,
      amount: 90,
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
    for (const id of [userId, otherUserId, emptyUserId]) {
      if (!id) continue;
      await db.query(`DELETE FROM expenses WHERE user_id = $1`, [id]);
      await db.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
  });

  test("no expenses: empty polar and zero type nets", async () => {
    const combined = await getExpenseChartsForMonth(emptyUserId, YEAR, 8);
    const old = await oldMonthPair(emptyUserId, YEAR, 8);
    expect(combined).toEqual(old);
    expect(combined.typeNets).toEqual({ necessary: 0, unnecessary: 0 });
    expect(combined.polar_area.slices).toEqual([]);
  });

  test("header-only month matches old helpers", async () => {
    const combined = await getExpenseChartsForMonth(userId, YEAR, 1);
    const old = await oldMonthPair(userId, YEAR, 1);
    expect(combined).toEqual(old);
    expect(combined.typeNets.necessary).toBe(1000.5);
    expect(combined.polar_area.slices[0].category).toBe("Food");
  });

  test("unwanted header expenses match old helpers", async () => {
    const combined = await getExpenseChartsForMonth(userId, YEAR, 3);
    const old = await oldMonthPair(userId, YEAR, 3);
    expect(combined).toEqual(old);
    expect(combined.typeNets.necessary).toBe(0);
    expect(combined.typeNets.unnecessary).toBe(330.25);
  });

  test("multiple splits match old helpers", async () => {
    const combined = await getExpenseChartsForMonth(userId, YEAR, 5);
    const old = await oldMonthPair(userId, YEAR, 5);
    expect(combined).toEqual(old);
    expect(combined.typeNets).toEqual({ necessary: 250, unnecessary: 150 });
    const labels = combined.polar_area.labels;
    expect(labels).toEqual(expect.arrayContaining(["Rent", "Games"]));
    expect(labels).not.toContain("Mixed");
  });

  test("multiple header returns stay on the parent month", async () => {
    const combined = await getExpenseChartsForMonth(userId, YEAR, 8);
    const old = await oldMonthPair(userId, YEAR, 8);
    expect(combined).toEqual(old);
    expect(combined.typeNets.necessary).toBe(259.5);
    const september = await getExpenseChartsForMonth(userId, YEAR, 9);
    expect(september.typeNets).toEqual({ necessary: 0, unnecessary: 0 });
  });

  test("splits plus category-matched returns match old helpers", async () => {
    const combined = await getExpenseChartsForMonth(userId, YEAR, 10);
    const old = await oldMonthPair(userId, YEAR, 10);
    expect(combined).toEqual(old);
    expect(combined.typeNets.necessary).toBe(250);
    expect(combined.typeNets.unnecessary).toBe(189.6);
  });

  test("empty months stay zero", async () => {
    const combined = await getExpenseChartsForMonth(userId, YEAR, 2);
    const old = await oldMonthPair(userId, YEAR, 2);
    expect(combined).toEqual(old);
    expect(combined.typeNets).toEqual({ necessary: 0, unnecessary: 0 });
  });

  test("user isolation", async () => {
    const mine = await getExpenseChartsForMonth(userId, YEAR, 3);
    const other = await getExpenseChartsForMonth(otherUserId, YEAR, 3);
    expect(mine).toEqual(await oldMonthPair(userId, YEAR, 3));
    expect(other).toEqual(await oldMonthPair(otherUserId, YEAR, 3));
    expect(other.typeNets.unnecessary).toBe(777);
    expect(mine.typeNets.unnecessary).toBe(330.25);
    expect(mine.polar_area.labels).not.toContain("OtherUser");
  });

  test("year combined matches polar + 12 monthly type nets", async () => {
    const combined = await getExpenseChartsForYear(userId, YEAR);
    const old = await oldYearPair(userId, YEAR);
    expect(combined.polar_area).toEqual(old.polar_area);
    expect(combined.typeNetsByMonth).toEqual(old.typeNetsByMonth);
    expect(combined.typeNetsByMonth).toHaveLength(12);
    expect(combined.typeNetsByMonth[1]).toEqual({
      month: 2,
      year: YEAR,
      necessary: 0,
      unnecessary: 0,
    });
  });

  test("year boundary excludes next calendar year", async () => {
    const combined = await getExpenseChartsForYear(userId, YEAR);
    expect(combined.polar_area.labels).not.toContain("NextYear");
    expect(combined.typeNetsByMonth[11].unnecessary).toBe(90);
    const nextJan = await getExpenseChartsForMonth(userId, YEAR + 1, 1);
    expect(nextJan.typeNets.necessary).toBe(999);
    expect(nextJan).toEqual(await oldMonthPair(userId, YEAR + 1, 1));
  });

  test("month dashboard polar and type nets match old helpers", async () => {
    const dashboard = await buildDashboard(userId, YEAR, 10, "month");
    const old = await oldMonthPair(userId, YEAR, 10);
    expect(dashboard.charts.polar_area.slices).toEqual(old.polar_area.slices);
    expect(dashboard.charts.polar_area.labels).toEqual(old.polar_area.labels);
    expect(dashboard.charts.polar_area.series).toEqual(old.polar_area.series);
    expect(dashboard.charts.polar_area.colors).toEqual(old.polar_area.colors);
    expect(dashboard.charts.polar_area.grand_total).toEqual(old.polar_area.grand_total);
    expect(dashboard.necessary).toBe(old.typeNets.necessary);
    expect(dashboard.unnecessary).toBe(old.typeNets.unnecessary);
    expect(dashboard.earned).toEqual(expect.any(Number));
    expect(dashboard.not_earned).toEqual(expect.any(Number));
    expect(dashboard.income).toEqual(expect.any(Number));
    expect(dashboard.previous_balance).toEqual(expect.any(Number));
    expect(dashboard.available).toEqual(expect.any(Number));
    expect(dashboard.spent).toEqual(expect.any(Number));
    expect(dashboard.balance).toEqual(expect.any(Number));
    expect(dashboard.from_savings).toEqual(expect.any(Number));
    expect(dashboard.debt).toEqual(expect.any(Number));
    expect(dashboard.charts.monthly_trend.points).toHaveLength(12);
    expect(dashboard.charts.monthly_trend.series.map((s) => s.key)).toEqual([
      "earned",
      "spent",
      "from_savings",
      "balance",
    ]);
    expect(dashboard.charts.payments_by_type.title).toBe("Payments by Type");
    expect(dashboard.charts.payments_by_type.labels).toEqual([]);
    expect(dashboard.charts.payments_by_type.items).toEqual([]);
    expect(dashboard.charts.monthly_debt_trend).toBeUndefined();
    expect(dashboard.charts.spending_breakdown).toBeTruthy();
    expect(dashboard.charts.expense_type).toBeTruthy();
    expect(dashboard.emi_overview.products).toEqual([]);
    expect(dashboard.emi_overview.paid_this_period).toBe(0);
    expect(dashboard.emi_overview.remaining_emis).toBe(0);
  });

  test("year dashboard polar and type nets match old helpers", async () => {
    const dashboard = await buildDashboard(userId, YEAR, null, "year");
    const old = await oldYearPair(userId, YEAR);
    const expectedNecessary = old.typeNetsByMonth.reduce(
      (sum, row) => sum + row.necessary,
      0
    );
    const expectedUnnecessary = old.typeNetsByMonth.reduce(
      (sum, row) => sum + row.unnecessary,
      0
    );
    expect(dashboard.charts.polar_area.slices).toEqual(old.polar_area.slices);
    expect(dashboard.charts.polar_area.labels).toEqual(old.polar_area.labels);
    expect(dashboard.charts.polar_area.series).toEqual(old.polar_area.series);
    expect(dashboard.necessary).toBe(expectedNecessary);
    expect(dashboard.unnecessary).toBe(expectedUnnecessary);
    dashboard.charts.monthly_trend.points.forEach((point) => {
      const monthNets = old.typeNetsByMonth[point.month - 1];
      expect(point.necessary).toBe(monthNets.necessary);
      expect(point.unnecessary).toBe(monthNets.unnecessary);
    });
    expect(dashboard.charts.monthly_debt_trend).toBeUndefined();
    expect(dashboard.charts.payments_by_type.items).toEqual([]);
    expect(dashboard.charts.monthly_trend.series.map((s) => s.key)).not.toContain("debt");
  });

  test("month and year dashboards issue one combined expense-chart query and the current dashboard read set", async () => {
    const stop = installQueryProfile(db);
    try {
      resetQueryProfile();
      await buildDashboard(userId, YEAR, 5, "month");
      expectDashboardQueryContract(getQueryProfile());

      resetQueryProfile();
      await buildDashboard(userId, YEAR, null, "year");
      expectDashboardQueryContract(getQueryProfile());
    } finally {
      stop();
    }
  });
});
