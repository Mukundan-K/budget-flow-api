require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedDebts = require("../src/seed/debts");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const {
  calculatePersonBalances,
  monthlyDebtTrendPoint,
} = require("../src/services/financial/debt.service");
const {
  getMonthlyDebtTrendForYear,
} = require("../src/services/financial/debtMonth.service");
const { buildDashboard } = require("../src/routes/overview.routes");
const {
  listOutstandingByPerson,
} = require("../src/services/financial/debtTransactions.service");

const SUFFIX = `mdt_${Date.now()}`;
const YEAR = 2021;

let userId;
let personId;
let otherPersonId;

function expectedPoint(month, iOweThem, theyOweMe, year = YEAR) {
  const netDebt = iOweThem - theyOweMe;
  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    year,
    month_number: month,
    i_owe_them: iOweThem,
    they_owe_me: theyOweMe,
    net_debt: netDebt,
    iOweThem,
    theyOweMe,
    netDebt,
  };
}

async function insertDebt(type, amount, date, options = {}) {
  const pid = options.personId || personId;
  const createdAt = options.createdAt
    ? parseTimestamp(options.createdAt)
    : null;
  if (createdAt) {
    await db.query(
      `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, pid, amount, type, parseTimestamp(date), createdAt]
    );
    return;
  }
  await db.query(
    `INSERT INTO debts (user_id, person_id, amount, debt_type, debt_date)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, pid, amount, type, parseTimestamp(date)]
  );
}

function monthPoint(points, month) {
  return points.find(
    (p) => p.month === `${YEAR}-${String(month).padStart(2, "0")}`
  );
}

describe("monthly debt trend from debts.debt_date", () => {
  beforeAll(async () => {
    await seedDebts();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Monthly Debt Trend", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const person = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, "Asha"]
    );
    personId = person.rows[0].id;

    const other = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING id`,
      [userId, "Bala"]
    );
    otherPersonId = other.rows[0].id;
  });

  afterAll(async () => {
    if (userId) {
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  afterEach(async () => {
    await db.query(`DELETE FROM debts WHERE user_id = $1`, [userId]);
  });

  test("uses the outstanding formula and keeps negative monthly balances", () => {
    const july = monthlyDebtTrendPoint(YEAR, 7, {
      received_total: 10000,
      returned_by_me: 15000,
      given_total: 2000,
      returned_to_me: 5000,
    });
    const expected = calculatePersonBalances({
      received_total: 10000,
      returned_by_me: 15000,
      given_total: 2000,
      returned_to_me: 5000,
    });

    expect(july.month).toBe("2021-07");
    expect(july.i_owe_them).toBe(-5000);
    expect(july.they_owe_me).toBe(-3000);
    expect(july.net_debt).toBe(-2000);
    expect(july.i_owe_them).toBe(expected.i_owe_them);
    expect(july.they_owe_me).toBe(expected.they_owe_me);
    expect(july.net_debt).toBe(expected.net_amount);
    expect(july.net_debt).toBe(july.i_owe_them - july.they_owe_me);
  });

  test("received increases I Owe Them for that month", async () => {
    await insertDebt("received", 15000, `${YEAR}-07-10`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const july = monthPoint(points, 7);
    expect(july.i_owe_them).toBe(15000);
    expect(july.they_owe_me).toBe(0);
    expect(july.net_debt).toBe(15000);
  });

  test("given increases They Owe Me for that month", async () => {
    await insertDebt("given", 4000, `${YEAR}-08-02`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const aug = monthPoint(points, 8);
    expect(aug.i_owe_them).toBe(0);
    expect(aug.they_owe_me).toBe(4000);
    expect(aug.net_debt).toBe(-4000);
  });

  test("returned_by_me decreases I Owe Them in the debt_date month", async () => {
    await insertDebt("received", 15000, `${YEAR}-07-01`);
    await insertDebt("returned_by_me", 4000, `${YEAR}-07-20`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const july = monthPoint(points, 7);
    expect(july.i_owe_them).toBe(11000);
    expect(july.net_debt).toBe(11000);
  });

  test("returned_to_me decreases They Owe Me in the debt_date month", async () => {
    await insertDebt("given", 5200, `${YEAR}-08-01`);
    await insertDebt("returned_to_me", 1200, `${YEAR}-08-18`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const aug = monthPoint(points, 8);
    expect(aug.they_owe_me).toBe(4000);
    expect(aug.net_debt).toBe(-4000);
  });

  test("historical return dates use debt_date, not created_at", async () => {
    await insertDebt("received", 8000, `${YEAR}-07-05`);
    await insertDebt("returned_by_me", 2500, `${YEAR}-07-28`, {
      createdAt: `${YEAR}-09-11`,
    });
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const july = monthPoint(points, 7);
    const sep = monthPoint(points, 9);
    expect(july.i_owe_them).toBe(5500);
    expect(july.net_debt).toBe(5500);
    expect(sep.i_owe_them).toBe(5500);
    expect(sep.net_debt).toBe(5500);
  });

  test("sums multiple transactions in the same month", async () => {
    await insertDebt("received", 1000, `${YEAR}-07-01`);
    await insertDebt("received", 2000, `${YEAR}-07-15`);
    await insertDebt("given", 400, `${YEAR}-07-08`);
    await insertDebt("given", 600, `${YEAR}-07-22`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const july = monthPoint(points, 7);
    expect(july.i_owe_them).toBe(3000);
    expect(july.they_owe_me).toBe(1000);
    expect(july.net_debt).toBe(2000);
  });

  test("includes a negative person balance in the monthly totals", async () => {
    await insertDebt("received", 1000, `${YEAR}-07-01`, {
      personId,
    });
    await insertDebt("returned_by_me", 1100, `${YEAR}-07-12`, {
      personId,
    });
    await insertDebt("given", 4000, `${YEAR}-07-20`, {
      personId: otherPersonId,
    });
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const july = monthPoint(points, 7);
    expect(july.i_owe_them).toBe(-100);
    expect(july.they_owe_me).toBe(4000);
    expect(july.net_debt).toBe(-4100);
  });

  test("fills the same 12-month range as monthly trend and carries idle months", async () => {
    await insertDebt("received", 15000, `${YEAR}-07-10`);
    await insertDebt("given", 4000, `${YEAR}-08-02`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    expect(points).toHaveLength(12);
    expect(points.map((p) => p.month)).toEqual([
      "2021-01",
      "2021-02",
      "2021-03",
      "2021-04",
      "2021-05",
      "2021-06",
      "2021-07",
      "2021-08",
      "2021-09",
      "2021-10",
      "2021-11",
      "2021-12",
    ]);
    expect(monthPoint(points, 1)).toEqual(expectedPoint(1, 0, 0));
    expect(monthPoint(points, 7)).toEqual(expectedPoint(7, 15000, 0));
    expect(monthPoint(points, 8)).toEqual(expectedPoint(8, 15000, 4000));
    expect(monthPoint(points, 9)).toEqual(expectedPoint(9, 15000, 4000));
    expect(monthPoint(points, 12)).toEqual(expectedPoint(12, 15000, 4000));
  });

  test("builds running month-end balances like the dashboard example", async () => {
    await insertDebt("received", 15000, `${YEAR}-07-10`);
    await insertDebt("given", 4000, `${YEAR}-07-12`);
    await insertDebt("received", 3500, `${YEAR}-08-05`);
    await insertDebt("given", 1200, `${YEAR}-08-18`);
    await insertDebt("received", 1354, `${YEAR}-09-02`);
    await insertDebt("given", 1041, `${YEAR}-09-20`);

    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    expect(monthPoint(points, 7)).toEqual(expectedPoint(7, 15000, 4000));
    expect(monthPoint(points, 8)).toEqual(expectedPoint(8, 18500, 5200));
    expect(monthPoint(points, 9)).toEqual(expectedPoint(9, 19854, 6241));
    expect(monthPoint(points, 9).netDebt).toBe(13613);

    const outstanding = await listOutstandingByPerson(userId);
    const december = monthPoint(points, 12);
    expect(december.i_owe_them).toBe(outstanding.i_owe_them);
    expect(december.they_owe_me).toBe(outstanding.they_owe_me);
    expect(december.net_debt).toBe(outstanding.net_amount);
  });

  test("includes prior-year history in later month-end balances", async () => {
    await insertDebt("received", 8000, `${YEAR - 1}-12-15`);
    await insertDebt("given", 2000, `${YEAR}-03-01`);
    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    expect(monthPoint(points, 1)).toEqual(expectedPoint(1, 8000, 0));
    expect(monthPoint(points, 2)).toEqual(expectedPoint(2, 8000, 0));
    expect(monthPoint(points, 3)).toEqual(expectedPoint(3, 8000, 2000));
  });

  test("dashboard monthly_debt_trend uses running balances without a Net Debt series", async () => {
    await insertDebt("received", 15000, `${YEAR}-07-10`);
    await insertDebt("given", 4000, `${YEAR}-08-05`);
    await insertDebt("received", 3500, `${YEAR}-08-20`);
    await insertDebt("returned_to_me", 800, `${YEAR}-08-28`);
    await insertDebt("returned_by_me", 2500, `${YEAR}-07-22`, {
      createdAt: `${YEAR}-09-01`,
    });

    const points = await getMonthlyDebtTrendForYear(userId, YEAR);
    const july = monthPoint(points, 7);
    const aug = monthPoint(points, 8);
    expect(july).toEqual(expectedPoint(7, 12500, 0));
    expect(aug).toEqual(expectedPoint(8, 16000, 3200));
    expect(aug.net_debt).toBe(aug.i_owe_them - aug.they_owe_me);
    expect(monthPoint(points, 12)).toEqual(expectedPoint(12, 16000, 3200));

    const dashboard = await buildDashboard(userId, YEAR, 8, "month");
    const chart = dashboard.charts.monthly_debt_trend;
    expect(chart.title).toBe("Monthly Debt Trend");
    expect(chart.labels).toHaveLength(12);
    expect(chart.labels[6]).toBe("Jul 2021");
    expect(chart.labels[7]).toBe("Aug 2021");
    expect(chart.series.map((s) => s.name)).toEqual([
      "I Owe Them",
      "They Owe Me",
    ]);
    expect(chart.points).toEqual(points);
    expect(chart.series[0].data[6]).toBe(12500);
    expect(chart.series[0].data[7]).toBe(16000);
    expect(chart.series[1].data[7]).toBe(3200);
    expect(chart.series).toHaveLength(2);
  });
});
