const { classifyQuery } = require("../src/utils/queryProfile");

describe("classifyQuery dashboard fingerprints", () => {
  test("outgoing payment groups is not counted as paid-months", () => {
    const sql = `
      SELECT pt.id AS payment_type_id, pt.name AS payment_type_name
      FROM payments p
      JOIN payment_types pt ON pt.id = p.payment_type_id
      LEFT JOIN emi_products ep ON ep.id = p.emi_product_id
      LEFT JOIN (
        SELECT emi_product_id,
               COUNT(DISTINCT DATE_TRUNC('month', timezone($4, payment_date)))::int AS paid_months
        FROM payments
        WHERE user_id = $1 AND emi_product_id IS NOT NULL
        GROUP BY emi_product_id
      ) emi_paid ON emi_paid.emi_product_id = ep.id
      WHERE p.user_id = $1 AND pt.flow = 'outgoing'
      GROUP BY pt.id, pt.name, ep.id`;
    expect(classifyQuery(sql)).toBe("outgoing_payment_groups");
  });

  test("month-range debt activity is not counted as trend opening", () => {
    const activity = `
      SELECT
        COALESCE(SUM(CASE WHEN debt_type = 'given' THEN amount ELSE 0 END), 0) AS given_total,
        COALESCE(SUM(CASE WHEN debt_type = 'received' THEN amount ELSE 0 END), 0) AS received_total
      FROM debts
      WHERE user_id = $1
        AND debt_date >= $2
        AND debt_date <= $3`;
    const opening = `
      SELECT
        COALESCE(SUM(CASE WHEN debt_type = 'received' THEN amount ELSE 0 END), 0) AS received_total
      FROM debts
      WHERE user_id = $1
        AND debt_date < $2`;
    const yearBuckets = `
      SELECT EXTRACT(MONTH FROM (debt_date AT TIME ZONE $4))::int AS month
      FROM debts
      WHERE user_id = $1
        AND debt_date >= $2
        AND debt_date <= $3
      GROUP BY 1`;

    expect(classifyQuery(activity)).toBe("debt_originated");
    expect(classifyQuery(opening)).toBe("monthly_debt_trend_opening");
    expect(classifyQuery(yearBuckets)).toBe("monthly_debt_trend");
  });

  test("EMI overview queries keep distinct names", () => {
    expect(
      classifyQuery(`SELECT ep.id FROM emi_products ep WHERE ep.user_id = $1`)
    ).toBe("emi_products");
    expect(
      classifyQuery(`
        SELECT emi_product_id,
               COUNT(DISTINCT DATE_TRUNC('month', timezone($2, payment_date)))::int AS paid_months
        FROM payments
        WHERE user_id = $1 AND emi_product_id IS NOT NULL
        GROUP BY emi_product_id`)
    ).toBe("emi_paid_months");
    expect(
      classifyQuery(`
        SELECT p.emi_product_id,
               COALESCE(SUM(p.amount), 0) AS paid_amount
        FROM payments p
        WHERE p.emi_product_id IS NOT NULL`)
    ).toBe("emi_period_payments");
  });
});
