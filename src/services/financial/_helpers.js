const { formatAmount, addAmounts, parseAmount } = require("../../utils/money");

function roundMoney(value) {
  return formatAmount(value);
}

function toAmount(value) {
  const amount = parseAmount(value);
  return amount === null ? 0 : amount;
}

/**
 * Safe percentage: round(part / whole × 100), 0 when whole ≤ 0.
 * Never returns NaN / Infinity.
 */
function safePercentage(part, whole, { clamp = false } = {}) {
  const p = toAmount(part);
  const w = toAmount(whole);
  if (w <= 0) return 0;
  let value = Math.round((p / w) * 100);
  if (clamp) {
    if (value < 0) value = 0;
    if (value > 100) value = 100;
  }
  return value;
}

module.exports = {
  roundMoney,
  toAmount,
  addAmounts,
  parseAmount,
  formatAmount,
  safePercentage,
};
