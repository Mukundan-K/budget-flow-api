const { roundMoney, toAmount } = require("./_helpers");

/**
 * Savings net = credited (saved) − debited
 */
function calculateSavingsNet(credited = 0, debited = 0) {
  return roundMoney(toAmount(credited) - toAmount(debited));
}

function calculateSavingsAmounts({
  credited = 0,
  debited = 0,
  amount_saved,
  amount_debited,
} = {}) {
  const saved = toAmount(
    amount_saved !== undefined ? amount_saved : credited
  );
  const out = toAmount(
    amount_debited !== undefined ? amount_debited : debited
  );
  const net = calculateSavingsNet(saved, out);
  return {
    saved,
    credited: saved,
    amount_saved: saved,
    debited: out,
    amount_debited: out,
    net,
    month_net: net,
    available: net,
  };
}

module.exports = {
  calculateSavingsNet,
  calculateSavingsAmounts,
};
