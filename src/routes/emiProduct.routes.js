const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  badRequest,
  notFound,
  serverError,
} = require("../utils/response");
const { formatTimestamp } = require("../utils/datetime");

function mapEmiProduct(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    product_name: row.product_name,
    start_date: formatTimestamp(row.emi_start_from),
    already_paid: Number(row.already_paid || 0),
    number_of_emis: Number(row.number_of_emis),
    created_at: formatTimestamp(row.created_at) || row.created_at,
  };
}

// List EMI products (for "existing" dropdown)
// GET /api/emi-products?user_id=1
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const result = await db.query(
      `SELECT id, user_id, product_name, emi_start_from, already_paid, number_of_emis, created_at
       FROM emi_products
       WHERE user_id = $1
       ORDER BY product_name ASC`,
      [user_id]
    );

    return success(
      res,
      result.rows.map(mapEmiProduct),
      "EMI products fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching EMI products");
  }
});

// Get one EMI product
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, user_id, product_name, emi_start_from, already_paid, number_of_emis, created_at
       FROM emi_products
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "EMI product not found");
    }

    return success(
      res,
      mapEmiProduct(result.rows[0]),
      "EMI product fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching EMI product");
  }
});

module.exports = router;
