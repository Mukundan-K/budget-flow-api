const express = require("express");
const router = express.Router();
const db = require("../db");
const {
  success,
  created,
  badRequest,
  notFound,
  conflict,
  serverError,
} = require("../utils/response");

function mapPerson(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    created_at: row.created_at,
  };
}

function validatePayload(body, { partial = false } = {}) {
  const errors = [];

  if (!partial || body.name !== undefined) {
    if (!body.name || String(body.name).trim() === "") {
      errors.push("name is required");
    }
  }

  if (!partial || body.user_id !== undefined) {
    if (body.user_id === undefined || body.user_id === null || body.user_id === "") {
      errors.push("user_id is required");
    }
  }

  return errors;
}

// Create person
router.post("/", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const name = String(req.body.name).trim();
    const user_id = req.body.user_id;

    const result = await db.query(
      `INSERT INTO persons (user_id, name)
       VALUES ($1, $2)
       RETURNING *`,
      [user_id, name]
    );

    return created(res, mapPerson(result.rows[0]), "Person created successfully");
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Person with this name already exists for the user");
    }
    console.error(err);
    return serverError(res, "Error creating person");
  }
});

// List persons
router.get("/", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return badRequest(res, "user_id is required");
    }

    const result = await db.query(
      `SELECT * FROM persons
       WHERE user_id = $1
       ORDER BY name ASC`,
      [user_id]
    );

    return success(
      res,
      result.rows.map(mapPerson),
      "Persons fetched successfully"
    );
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching persons");
  }
});

// Get one
router.get("/:id", async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM persons WHERE id = $1`, [
      req.params.id,
    ]);

    if (result.rows.length === 0) {
      return notFound(res, "Person not found");
    }

    return success(res, mapPerson(result.rows[0]), "Person fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching person");
  }
});

// Update (full)
router.put("/:id", async (req, res) => {
  try {
    const errors = validatePayload(req.body);
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const name = String(req.body.name).trim();
    const user_id = req.body.user_id;

    const result = await db.query(
      `UPDATE persons
       SET user_id = $1, name = $2
       WHERE id = $3
       RETURNING *`,
      [user_id, name, req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Person not found");
    }

    return success(res, mapPerson(result.rows[0]), "Person updated successfully");
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Person with this name already exists for the user");
    }
    console.error(err);
    return serverError(res, "Error updating person");
  }
});

// Update (partial)
router.patch("/:id", async (req, res) => {
  try {
    const existing = await db.query(`SELECT * FROM persons WHERE id = $1`, [
      req.params.id,
    ]);

    if (existing.rows.length === 0) {
      return notFound(res, "Person not found");
    }

    const errors = validatePayload(req.body, { partial: true });
    if (errors.length) {
      return badRequest(res, errors.join(", "));
    }

    const current = existing.rows[0];
    const name =
      req.body.name !== undefined
        ? String(req.body.name).trim()
        : current.name;
    const user_id = req.body.user_id ?? current.user_id;

    const result = await db.query(
      `UPDATE persons
       SET user_id = $1, name = $2
       WHERE id = $3
       RETURNING *`,
      [user_id, name, req.params.id]
    );

    return success(res, mapPerson(result.rows[0]), "Person updated successfully");
  } catch (err) {
    if (err.code === "23505") {
      return conflict(res, "Person with this name already exists for the user");
    }
    console.error(err);
    return serverError(res, "Error updating person");
  }
});

// Delete
router.delete("/:id", async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM persons WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "Person not found");
    }

    return success(
      res,
      mapPerson(result.rows[0]),
      "Person deleted successfully"
    );
  } catch (err) {
    if (err.code === "23503") {
      return conflict(res, "Cannot delete person that is used by debts");
    }
    console.error(err);
    return serverError(res, "Error deleting person");
  }
});

module.exports = router;
