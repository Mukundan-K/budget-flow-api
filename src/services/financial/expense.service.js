const { roundMoney, toAmount, addAmounts } = require("./_helpers");

/**
 * Resolve expense returned_amount:
 * - if split return total > 0 → use it
 * - otherwise → use header returned_amount (if any)
 */
function resolveExpenseReturnedAmount({
  splitReturnedTotal = 0,
  headerReturnedAmount = 0,
} = {}) {
  const splitTotal = toAmount(splitReturnedTotal);
  if (splitTotal > 0) return splitTotal;
  return toAmount(headerReturnedAmount);
}

/**
 * net_amount = amount − returned_amount
 * my_contribution preserves existing meaning (= net for the expense / split)
 */
function calculateExpenseNet(amount, returnedAmount = 0) {
  return roundMoney(toAmount(amount) - toAmount(returnedAmount));
}

function calculateExpenseContribution(netAmount) {
  return roundMoney(netAmount);
}

/**
 * Build canonical expense amount fields from header + optional category splits.
 */
function calculateExpenseAmounts({
  amount,
  headerReturnedAmount = 0,
  splits = null,
  returnsByCategory = {},
  fallbackExpenseType = true,
} = {}) {
  const headerAmount = toAmount(amount);

  const categorySplits =
    splits && splits.length
      ? splits
      : [
          {
            category: "General",
            amount: headerAmount,
            expense_type: fallbackExpenseType,
          },
        ];

  const normalizedSplits = categorySplits.map((s) => {
    const splitAmount = toAmount(s.amount);
    const key = String(s.category);
    const returned_amount = toAmount(
      returnsByCategory[key] ??
        returnsByCategory[key.toLowerCase()] ??
        s.returned_amount ??
        0
    );
    const net_amount = calculateExpenseNet(splitAmount, returned_amount);
    return {
      category: s.category,
      amount: splitAmount,
      expense_type:
        s.expense_type === undefined || s.expense_type === null
          ? fallbackExpenseType
          : Boolean(s.expense_type),
      returned_amount,
      net_amount,
      my_contribution: calculateExpenseContribution(net_amount),
    };
  });

  const splitReturnedTotal = roundMoney(
    addAmounts(...normalizedSplits.map((s) => s.returned_amount))
  );
  const returned_amount = resolveExpenseReturnedAmount({
    splitReturnedTotal,
    headerReturnedAmount,
  });
  const net_amount = calculateExpenseNet(headerAmount, returned_amount);

  return {
    amount: headerAmount,
    returned_amount,
    net_amount,
    my_contribution: calculateExpenseContribution(net_amount),
    categories: normalizedSplits,
    is_split: normalizedSplits.length > 1,
  };
}

module.exports = {
  resolveExpenseReturnedAmount,
  calculateExpenseNet,
  calculateExpenseContribution,
  calculateExpenseAmounts,
};
