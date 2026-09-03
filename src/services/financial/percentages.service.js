const { roundMoney, toAmount } = require("./_helpers");
const { safePercentage } = require("./_helpers");

/**
 * Dashboard used % = min(100, round(total_deductions / available × 100))
 * available = earned + previous_month_balance
 */
function calculateDashboardUsedPercentage(totalDeductions, available) {
  return safePercentage(totalDeductions, available, { clamp: true });
}

/**
 * Necessary share % = round(necessary / (necessary + unnecessary) × 100)
 */
function calculateNecessarySharePercentage(necessary, unnecessary) {
  const n = toAmount(necessary);
  const u = toAmount(unnecessary);
  return safePercentage(n, n + u);
}

/**
 * Saved share % = round(saved / (saved + debited) × 100)
 */
function calculateSavedSharePercentage(saved, debited) {
  const s = toAmount(saved);
  const d = toAmount(debited);
  return safePercentage(s, s + d);
}

function calculateSharePercentage(part, whole) {
  return safePercentage(part, whole);
}

/** Chart-style pct (full precision via formatAmount, 0 when whole ≤ 0). */
function pct(part, whole) {
  const w = toAmount(whole);
  if (w <= 0) return 0;
  return roundMoney((toAmount(part) / w) * 100);
}

function calculateDashboardPercentages({
  total_deductions = 0,
  available = 0,
  necessary = 0,
  unnecessary = 0,
  saved = 0,
  debited = 0,
} = {}) {
  return {
    dashboard_used_percentage: calculateDashboardUsedPercentage(
      total_deductions,
      available
    ),
    necessary_share_percentage: calculateNecessarySharePercentage(
      necessary,
      unnecessary
    ),
    saved_share_percentage: calculateSavedSharePercentage(saved, debited),
  };
}

module.exports = {
  calculateDashboardUsedPercentage,
  calculateNecessarySharePercentage,
  calculateSavedSharePercentage,
  calculateSharePercentage,
  calculateDashboardPercentages,
  pct,
};
