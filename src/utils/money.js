/**
 * Money helpers — keep full decimal precision (no 2-decimal trimming).
 */

function parseAmount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value).trim().replace(/,/g, "");
  if (normalized === "") return null;

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return amount;
}

function addAmounts(...values) {
  return values.reduce((sum, value) => {
    const amount = parseAmount(value);
    return sum + (amount === null ? 0 : amount);
  }, 0);
}

function formatAmount(value) {
  const amount = parseAmount(value);
  if (amount === null) return 0;
  // Avoid scientific notation / float noise for API responses
  return Number(amount);
}

module.exports = {
  parseAmount,
  addAmounts,
  formatAmount,
};
