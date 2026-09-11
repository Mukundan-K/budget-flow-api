const {
  emiPaidMonthsCountSql,
  emiPaidMonthsJoinSql,
  paidCountFromRow,
  calculateEmiProgress,
  attachPaidMonthsToPaymentRows,
  getPaidMonthsByUser,
} = require("../src/services/financial");

describe("EMI distinct-month SQL", () => {
  test("counts distinct truncated months in the app timezone", () => {
    const sql = emiPaidMonthsCountSql("$2");
    expect(sql).toContain("COUNT(DISTINCT DATE_TRUNC('month'");
    expect(sql).toContain("timezone($2, payment_date)");
  });

  test("join aggregates by emi_product_id for one user", () => {
    const sql = emiPaidMonthsJoinSql({ userParam: "$1", tzParam: "$4" });
    expect(sql).toContain("WHERE user_id = $1");
    expect(sql).toContain("AND emi_product_id IS NOT NULL");
    expect(sql).toContain("GROUP BY emi_product_id");
    expect(sql).toContain("emi_paid.emi_product_id = ep.id");
  });
});

describe("paidCountFromRow", () => {
  test("EMI with no payments is 0", () => {
    expect(paidCountFromRow({ paid_months: 0 })).toBe(0);
    expect(paidCountFromRow({})).toBe(0);
  });

  test("tracked months do not use stored already_paid", () => {
    expect(paidCountFromRow({ already_paid: 7 })).toBe(0);
    expect(paidCountFromRow({ already_paid: 7, paid_months: 4 })).toBe(4);
  });
});

describe("previously paid + tracked months", () => {
  test("total_paid = already_paid + distinct months", () => {
    const result = calculateEmiProgress({
      already_paid: 8,
      paid_months: 2,
      number_of_emis: 24,
    });
    expect(result.already_paid).toBe(8);
    expect(result.previously_paid).toBe(8);
    expect(result.tracked_paid_months).toBe(2);
    expect(result.paid).toBe(10);
    expect(result.total_paid).toBe(10);
    expect(result.remaining).toBe(14);
  });

  test("payments do not replace the stored previously_paid count", () => {
    const before = calculateEmiProgress({
      already_paid: 8,
      paid_months: 0,
      number_of_emis: 24,
    });
    const afterAugust = calculateEmiProgress({
      already_paid: 8,
      paid_months: 1,
      number_of_emis: 24,
    });
    const afterSeptember = calculateEmiProgress({
      already_paid: 8,
      paid_months: 2,
      number_of_emis: 24,
    });
    const afterDeleteSeptember = calculateEmiProgress({
      already_paid: 8,
      paid_months: 1,
      number_of_emis: 24,
    });

    expect(before.already_paid).toBe(8);
    expect(afterAugust.already_paid).toBe(8);
    expect(afterAugust.total_paid).toBe(9);
    expect(afterSeptember.already_paid).toBe(8);
    expect(afterSeptember.total_paid).toBe(10);
    expect(afterDeleteSeptember.already_paid).toBe(8);
    expect(afterDeleteSeptember.total_paid).toBe(9);
  });
});

describe("attachPaidMonthsToPaymentRows", () => {
  test("loads paid months once and maps them per EMI", async () => {
    const client = {
      query: jest.fn(async () => ({
        rows: [
          { user_id: 1, emi_product_id: 10, paid_months: 4 },
          { user_id: 1, emi_product_id: 11, paid_months: 1 },
        ],
      })),
    };

    const rows = [
      { id: 1, user_id: 1, emi_product_id: 10 },
      { id: 2, user_id: 1, emi_product_id: 10 },
      { id: 3, user_id: 1, emi_product_id: 11 },
      { id: 4, user_id: 1, emi_product_id: null },
    ];

    const result = await attachPaidMonthsToPaymentRows(rows, client);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(result[0].paid_months).toBe(4);
    expect(result[1].paid_months).toBe(4);
    expect(result[2].paid_months).toBe(1);
    expect(result[3].paid_months).toBe(0);
  });

  test("another user's EMI counts do not attach to the current user", async () => {
    const client = {
      query: jest.fn(async () => ({
        rows: [{ user_id: 2, emi_product_id: 10, paid_months: 9 }],
      })),
    };

    const result = await attachPaidMonthsToPaymentRows(
      [{ id: 1, user_id: 1, emi_product_id: 10 }],
      client
    );

    expect(result[0].paid_months).toBe(0);
  });
});

describe("iPhone 15 validation scenario", () => {
  test("5 payments across 4 months → paid 4 remaining 10", () => {
    const paidMonths = new Set([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-03",
      "2026-04",
    ]).size;
    expect(paidMonths).toBe(4);

    const progress = calculateEmiProgress({
      already_paid: 0,
      paid_months: paidMonths,
      number_of_emis: 14,
    });
    expect(progress.tracked_paid_months).toBe(4);
    expect(progress.total_paid).toBe(4);
    expect(progress.already_paid).toBe(0);
    expect(progress.remaining).toBe(10);
    expect(progress.number_of_emis).toBe(14);
  });

  test("December 2026 and December 2027 count as two months", () => {
    const paidMonths = new Set(["2026-12", "2027-12"]).size;
    expect(paidMonths).toBe(2);
  });
});

describe("getPaidMonthsByUser query", () => {
  test("filters by user_id and non-null emi_product_id", async () => {
    const client = {
      query: jest.fn(async (sql, params) => {
        expect(sql).toContain("WHERE user_id = $1");
        expect(sql).toContain("emi_product_id IS NOT NULL");
        expect(sql).toContain("DATE_TRUNC('month'");
        expect(params[0]).toBe(3);
        return {
          rows: [{ emi_product_id: 5, paid_months: 2 }],
        };
      }),
    };

    const map = await getPaidMonthsByUser(3, client);
    expect(map.get(5)).toBe(2);
    expect(map.get(99)).toBeUndefined();
  });
});
