const express = require("express");
const router = express.Router();
const db = require("../db");
const { success, serverError } = require("../utils/response");
const { getMonths } = require("../masters/month.master");
const { getYears } = require("../masters/year.master");

/**
 * Read-only masters (months / years).
 * Payment types CRUD: /api/payment-types
 * Persons CRUD: /api/persons
 */

router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;

    const paymentTypes = await db.query(
      `SELECT id, name, flow, is_income, created_at
       FROM payment_types
       ORDER BY name ASC`
    );

    let persons = [];
    if (user_id) {
      const personsResult = await db.query(
        `SELECT id, user_id, name, created_at
         FROM persons
         WHERE user_id = $1
         ORDER BY name ASC`,
        [user_id]
      );
      persons = personsResult.rows;
    }

    return success(
      res,
      {
        months: getMonths(),
        years: getYears(),
        payment_types: paymentTypes.rows.map((row) => ({
          id: row.id,
          name: row.name,
          flow:
            row.flow === "incoming" || row.flow === "outgoing"
              ? row.flow
              : Boolean(row.is_income)
                ? "incoming"
                : "outgoing",
          is_income: Boolean(row.is_income),
          created_at: row.created_at,
        })),
        persons,
      },
      "Masters fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching masters");
  }
});

router.get("/months", (_req, res) => {
  return success(res, getMonths(), "Months fetched successfully");
});

router.get("/years", (_req, res) => {
  return success(res, getYears(), "Years fetched successfully");
});

module.exports = router;
