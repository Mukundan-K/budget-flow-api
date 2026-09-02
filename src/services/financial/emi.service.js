const { roundMoney, toAmount } = require("./_helpers");
const { safePercentage } = require("./_helpers");

/**
 * EMI progress fields.
 * paid = already_paid, total = number_of_emis
 * progress_percentage = round(paid / total × 100)
 * remaining = max(0, total − paid)
 */
function calculateEmiProgress({ paid = 0, total = 0, already_paid, number_of_emis } = {}) {
  const paidCount = toAmount(
    already_paid !== undefined ? already_paid : paid
  );
  const totalCount = toAmount(
    number_of_emis !== undefined ? number_of_emis : total
  );

  let remaining = null;
  if (number_of_emis != null || total) {
    remaining = Math.max(0, totalCount - paidCount);
  }

  const progress_percentage =
    totalCount > 0 ? safePercentage(paidCount, totalCount, { clamp: true }) : 0;

  return {
    paid: paidCount,
    already_paid: paidCount,
    total: totalCount || null,
    number_of_emis: totalCount || null,
    remaining,
    emis_left: remaining,
    progress_percentage,
  };
}

module.exports = {
  calculateEmiProgress,
};
