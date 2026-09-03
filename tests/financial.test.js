const {
  calculatePaymentNet,
  calculatePaymentAmounts,
  calculateExpenseNet,
  calculateExpenseAmounts,
  resolveExpenseReturnedAmount,
  calculateSavingsNet,
  calculateDebtOutstanding,
  calculateDebtAmounts,
  calculateDebtNet,
  calculateDebtSummary,
  calculatePreviousBalance,
  calculateMonthlyBalance,
  calculateFinancialSummary,
  calculateDashboardUsedPercentage,
  calculateNecessarySharePercentage,
  calculateSavedSharePercentage,
  calculateEmiProgress,
} = require("../src/services/financial");

describe("payment calculations", () => {
  test("net_amount = amount - returned_amount", () => {
    expect(calculatePaymentNet(1000, 100)).toBe(900);
    expect(calculatePaymentAmounts({ amount: 1000, returned_amount: 100 })).toEqual(
      expect.objectContaining({
        amount: 1000,
        returned_amount: 100,
        net_amount: 900,
        my_contribution: 900,
      })
    );
  });

  test("zero returned", () => {
    expect(calculatePaymentNet(500, 0)).toBe(500);
  });

  test("return can exceed amount (negative net)", () => {
    expect(calculatePaymentNet(1000, 1200)).toBe(-200);
  });
});

describe("expense calculations", () => {
  test("net and contribution", () => {
    expect(calculateExpenseNet(1000, 100)).toBe(900);
  });

  test("split returns take precedence over header", () => {
    expect(
      resolveExpenseReturnedAmount({
        splitReturnedTotal: 50,
        headerReturnedAmount: 200,
      })
    ).toBe(50);
    expect(
      resolveExpenseReturnedAmount({
        splitReturnedTotal: 0,
        headerReturnedAmount: 200,
      })
    ).toBe(200);
  });

  test("calculateExpenseAmounts with splits", () => {
    const result = calculateExpenseAmounts({
      amount: 1000,
      splits: [
        { category: "Food", amount: 600, expense_type: true },
        { category: "Fun", amount: 400, expense_type: false },
      ],
      returnsByCategory: { Food: 100 },
    });
    expect(result.returned_amount).toBe(100);
    expect(result.net_amount).toBe(900);
    expect(result.my_contribution).toBe(900);
    expect(result.categories[0].net_amount).toBe(500);
    expect(result.categories[1].net_amount).toBe(400);
  });

  test("return can exceed amount (negative net)", () => {
    expect(calculateExpenseNet(1000, 1500)).toBe(-500);
  });
});

describe("savings calculations", () => {
  test("net = credited - debited", () => {
    expect(calculateSavingsNet(5000, 1000)).toBe(4000);
    expect(calculateSavingsNet(0, 0)).toBe(0);
  });
});

describe("debt calculations", () => {
  test("outstanding and debt_net", () => {
    expect(calculateDebtOutstanding(10000, 2000)).toBe(8000);
    expect(calculateDebtNet(8000, 3000)).toBe(5000);
    const summary = calculateDebtSummary({
      given_total: 10000,
      given_returned: 2000,
      received_total: 5000,
      received_returned: 1000,
    });
    expect(summary.outstanding).toBe(12000);
    expect(summary.debt_net).toBe(4000);

    const open = calculateDebtAmounts({ amount: 1000, returned_amount: 200 });
    expect(open.is_pending_zero).toBe(false);
    expect(open.has_pending).toBe(true);

    const settled = calculateDebtAmounts({ amount: 1000, returned_amount: 1000 });
    expect(settled.is_pending_zero).toBe(true);
    expect(settled.has_pending).toBe(false);
  });
});

describe("previous balance", () => {
  test("uses calculated when no manual", () => {
    const result = calculatePreviousBalance({
      manual: null,
      calculated: -20000,
    });
    expect(result.previous_balance).toBe(-20000);
    expect(result.previous_balance_manual).toBe(false);
    expect(result.previous_balance_calculated).toBe(-20000);
  });

  test("manual override including zero", () => {
    const result = calculatePreviousBalance({
      manual: 87.2,
      calculated: -20000,
    });
    expect(result.previous_balance).toBe(87.2);
    expect(result.previous_balance_manual).toBe(true);
    expect(result.previous_balance_calculated).toBe(-20000);

    const zero = calculatePreviousBalance({ manual: 0, calculated: 100 });
    expect(zero.previous_balance).toBe(0);
    expect(zero.previous_balance_manual).toBe(true);
  });
});

describe("monthly Remaining", () => {
  test("Remaining = Incoming + Previous - Spent - Savings - Debt", () => {
    const result = calculateMonthlyBalance({
      incoming: 50000,
      previous: 20000,
      spent: 30000,
      savings: 5000,
      debt: 2000,
    });
    expect(result.remaining).toBe(33000);
    // available = earned (all incoming here) + previous
    expect(result.available).toBe(70000);
    expect(result.total_amount_to_spend).toBe(70000);
    expect(result.debt).toBe(2000);
    expect(result.current_balance).toBe(33000);
  });

  test("available is earned + previous, not including not_earned", () => {
    const result = calculateMonthlyBalance({
      earned: 40000,
      not_earned: 10000,
      previous: 5000,
      spent: 20000,
      savings: 0,
      debt: 0,
    });
    expect(result.incoming).toBe(50000);
    expect(result.available).toBe(45000);
    expect(result.available_split).toEqual({
      total: 45000,
      earned: 40000,
      not_earned: 10000,
      previous: 5000,
    });
    expect(result.earned).toBe(40000);
    expect(result.not_earned).toBe(10000);
    expect(result.total_amount_to_spend).toBe(55000);
    expect(result.remaining).toBe(35000);
  });

  test("Remaining without debt matches when debt is 0", () => {
    const result = calculateMonthlyBalance({
      incoming: 50000,
      previous: 20000,
      spent: 30000,
      savings: 5000,
    });
    expect(result.remaining).toBe(35000);
  });

  test("spent from expense + outgoing components", () => {
    const result = calculateMonthlyBalance({
      incoming: 58333.33,
      previous: 87.2,
      expense_total: 8213.9,
      outgoing_payments_total: 55249.73,
      savings: 9000,
    });
    expect(result.spent).toBeCloseTo(63463.63, 5);
    expect(result.remaining).toBeCloseTo(
      result.total_amount_to_spend - result.total_deductions,
      5
    );
  });

  test("next month previous = this remaining", () => {
    const august = calculateMonthlyBalance({
      incoming: 50000,
      previous: 10000,
      spent: 20000,
      savings: 5000,
    });
    expect(august.remaining).toBe(35000);

    const septemberPrev = calculatePreviousBalance({
      manual: null,
      calculated: august.remaining,
    });
    expect(septemberPrev.previous_balance).toBe(35000);
  });

  test("zeros and first month", () => {
    const result = calculateFinancialSummary({
      incoming: 0,
      previous_balance: 0,
      spent: 0,
      savings: 0,
    });
    expect(result.remaining).toBe(0);
  });
});

describe("percentages", () => {
  test("dashboard used % clamps at 100", () => {
    expect(calculateDashboardUsedPercentage(50, 100)).toBe(50);
    expect(calculateDashboardUsedPercentage(200, 100)).toBe(100);
    expect(calculateDashboardUsedPercentage(10, 0)).toBe(0);
  });

  test("necessary share", () => {
    expect(calculateNecessarySharePercentage(20000, 10000)).toBe(67);
    expect(calculateNecessarySharePercentage(0, 0)).toBe(0);
  });

  test("saved share", () => {
    expect(calculateSavedSharePercentage(5000, 1000)).toBe(83);
    expect(calculateSavedSharePercentage(0, 0)).toBe(0);
  });
});

describe("EMI progress", () => {
  test("progress and remaining", () => {
    const result = calculateEmiProgress({
      already_paid: 3,
      number_of_emis: 12,
    });
    expect(result.paid).toBe(3);
    expect(result.total).toBe(12);
    expect(result.remaining).toBe(9);
    expect(result.progress_percentage).toBe(25);
  });

  test("zero total safe", () => {
    const result = calculateEmiProgress({ already_paid: 0, number_of_emis: 0 });
    expect(result.progress_percentage).toBe(0);
  });
});
