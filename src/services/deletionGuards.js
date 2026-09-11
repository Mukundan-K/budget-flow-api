const db = require("../db");

const CATEGORY_IN_USE_MESSAGE =
  "This category is already used by existing expenses. Please remove or update those expenses before deleting the category.";
const PAYMENT_TYPE_IN_USE_MESSAGE =
  "This payment type is already used by existing payments. Please update those payments before deleting it.";
const BANK_ACCOUNT_IN_USE_MESSAGE =
  "This bank account is already linked to existing records. Please remove or update those records before deleting the account.";
const PERSON_IN_USE_MESSAGE =
  "This person is already linked to existing records. Please remove or update those records before deleting the person.";

function flagFromRow(row) {
  if (!row) return false;
  const value = row.in_use ?? row.exists;
  return value === true || value === "t" || value === "true" || Number(value) === 1;
}

async function isCategoryInUse(name, client = db) {
  const result = await client.query(
    `SELECT (
       EXISTS (SELECT 1 FROM expenses WHERE category = $1)
       OR EXISTS (SELECT 1 FROM expense_category_splits WHERE category = $1)
       OR EXISTS (SELECT 1 FROM expense_returns WHERE category = $1)
     ) AS in_use`,
    [name]
  );
  return flagFromRow(result.rows[0]);
}

async function isPaymentTypeInUse(id, client = db) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM payments WHERE payment_type_id = $1
     ) AS in_use`,
    [id]
  );
  return flagFromRow(result.rows[0]);
}

async function isBankAccountInUse(id, client = db) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM savings_transactions WHERE bank_account_id = $1
     ) AS in_use`,
    [id]
  );
  return flagFromRow(result.rows[0]);
}

async function isPersonInUse(id, client = db) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM debts WHERE person_id = $1
     ) AS in_use`,
    [id]
  );
  return flagFromRow(result.rows[0]);
}

async function emiHasLinkedPayments(id, client = db) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM payments WHERE emi_product_id = $1
     ) AS in_use`,
    [id]
  );
  return flagFromRow(result.rows[0]);
}

module.exports = {
  CATEGORY_IN_USE_MESSAGE,
  PAYMENT_TYPE_IN_USE_MESSAGE,
  BANK_ACCOUNT_IN_USE_MESSAGE,
  PERSON_IN_USE_MESSAGE,
  flagFromRow,
  isCategoryInUse,
  isPaymentTypeInUse,
  isBankAccountInUse,
  isPersonInUse,
  emiHasLinkedPayments,
};
