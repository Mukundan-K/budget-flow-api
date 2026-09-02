const payment = require("./payment.service");
const expense = require("./expense.service");
const savings = require("./savings.service");
const debt = require("./debt.service");
const emi = require("./emi.service");
const balance = require("./balance.service");
const percentages = require("./percentages.service");
const financialSummary = require("./financialSummary.service");
const helpers = require("./_helpers");

module.exports = {
  ...helpers,
  ...payment,
  ...expense,
  ...savings,
  ...debt,
  ...emi,
  ...balance,
  ...percentages,
  ...financialSummary,
};
