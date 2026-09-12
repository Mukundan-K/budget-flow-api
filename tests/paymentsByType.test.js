require("dotenv").config();

const db = require("../src/db");
const { parseTimestamp } = require("../src/utils/datetime");
const seedPayments = require("../src/seed/payments");
const seedMonthlyFinancialSummary = require("../src/seed/monthlyFinancialSummary");
const { buildDashboard } = require("../src/routes/overview.routes");

const SUFFIX = `pbt_${Date.now()}`;
const YEAR = 2020;

let userId;
let cashTypeId;
let upiTypeId;
let unusedTypeId;

async function insertPayment(typeId, amount, date) {
  await db.query(
    `INSERT INTO payments (amount, payment_date, user_id, payment_type_id)
     VALUES ($1, $2, $3, $4)`,
    [amount, parseTimestamp(date), userId, typeId]
  );
}

describe("dashboard payments by type", () => {
  beforeAll(async () => {
    await seedPayments();
    await seedMonthlyFinancialSummary();

    const user = await db.query(
      `INSERT INTO users (name, email, google_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ["Payments By Type", `${SUFFIX}@example.com`, SUFFIX]
    );
    userId = user.rows[0].id;

    const cash = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'incoming', TRUE)
       RETURNING id`,
      [`${SUFFIX}_Cash`]
    );
    cashTypeId = cash.rows[0].id;

    const upi = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'outgoing', FALSE)
       RETURNING id`,
      [`${SUFFIX}_UPI`]
    );
    upiTypeId = upi.rows[0].id;

    const unused = await db.query(
      `INSERT INTO payment_types (name, flow, is_income)
       VALUES ($1, 'outgoing', FALSE)
       RETURNING id`,
      [`${SUFFIX}_Credit Card`]
    );
    unusedTypeId = unused.rows[0].id;

    await insertPayment(cashTypeId, 8000, `${YEAR}-03-10`);
    await insertPayment(cashTypeId, 2000, `${YEAR}-03-20`);
    await insertPayment(upiTypeId, 3000, `${YEAR}-03-25`);
  });

  afterAll(async () => {
    if (userId) {
      await db.query(`DELETE FROM payments WHERE user_id = $1`, [userId]);
      await db.query(`DELETE FROM monthly_financial_summary WHERE user_id = $1`, [
        userId,
      ]);
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    const typeIds = [cashTypeId, upiTypeId, unusedTypeId].filter(Boolean);
    if (typeIds.length) {
      await db.query(`DELETE FROM payment_types WHERE id = ANY($1::int[])`, [
        typeIds,
      ]);
    }
  });

  test("groups actual payment amounts by payment type and omits unused types", async () => {
    const dashboard = await buildDashboard(userId, YEAR, 3, "month");
    const chart = dashboard.charts.payments_by_type;

    expect(chart.title).toBe("Payments by Type");
    expect(chart.type).toBe("bar");
    expect(chart.labels).toEqual([`${SUFFIX}_Cash`, `${SUFFIX}_UPI`]);
    expect(chart.series).toEqual([10000, 3000]);
    expect(chart.items.map((item) => item.payment_type_id)).toEqual([
      cashTypeId,
      upiTypeId,
    ]);
    expect(chart.labels).not.toContain(`${SUFFIX}_Credit Card`);
    expect(chart.series.every((value) => value !== 0)).toBe(true);
  });

  test("year mode keeps the same payment-type totals for the year", async () => {
    const dashboard = await buildDashboard(userId, YEAR, null, "year");
    const chart = dashboard.charts.payments_by_type;
    expect(chart.labels).toEqual([`${SUFFIX}_Cash`, `${SUFFIX}_UPI`]);
    expect(chart.series).toEqual([10000, 3000]);
  });
});
