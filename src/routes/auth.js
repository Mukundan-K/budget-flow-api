const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const authenticate = require("../middleware/authenticate");
const { tokenPair } = require("../utils/tokens");
const {
  success,
  unauthorized,
  notFound,
  serverError,
} = require("../utils/response");

const router = express.Router();

async function issueTokens(user) {
  const tokens = tokenPair(user);

  await pool.query("UPDATE users SET refresh_token=$1 WHERE id=$2", [
    tokens.refreshToken,
    user.id,
  ]);

  return tokens;
}

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    photo: row.photo,
    google_id: row.google_id,
  };
}

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
  }),
  async (req, res) => {
    try {
      const { accessToken, refreshToken } = await issueTokens(req.user);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:4200";

      res.redirect(
        `${frontendUrl}/login?accessToken=${encodeURIComponent(
          accessToken
        )}&refreshToken=${encodeURIComponent(refreshToken)}`
      );
    } catch (err) {
      console.error(err);
      return serverError(res, "Error completing login");
    }
  }
);

router.post("/refresh-token", async (req, res) => {
  const { refreshToken } = req.body || {};

  if (!refreshToken) {
    return unauthorized(res, "Refresh token missing");
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    const user = await pool.query("SELECT * FROM users WHERE id=$1", [
      decoded.id,
    ]);

    if (user.rows.length === 0) {
      return unauthorized(res, "User not found");
    }

    if (!user.rows[0].refresh_token || user.rows[0].refresh_token !== refreshToken) {
      return unauthorized(res, "Invalid refresh token");
    }

    const tokens = await issueTokens(user.rows[0]);

    return success(res, tokens, "Access token refreshed successfully");
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return unauthorized(res, "Refresh token expired");
    }
    return unauthorized(res, "Invalid refresh token");
  }
});

// Current user details (from access token)
router.get("/me", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, photo, google_id
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "User not found");
    }

    return success(res, mapUser(result.rows[0]), "User details fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching user details");
  }
});

// User details by id
router.get("/user/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, photo, google_id
       FROM users
       WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return notFound(res, "User not found");
    }

    return success(res, mapUser(result.rows[0]), "User details fetched successfully");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error fetching user details");
  }
});

router.post("/logout", async (req, res) => {
  try {
    const { userId, refreshToken } = req.body || {};
    let id = userId;

    if (!id && refreshToken) {
      try {
        const decoded = jwt.verify(
          refreshToken,
          process.env.JWT_REFRESH_SECRET
        );
        id = decoded.id;
      } catch (err) {
        const decoded = jwt.decode(refreshToken);
        id = decoded && decoded.id;
      }
    }

    if (id) {
      await pool.query("UPDATE users SET refresh_token=NULL WHERE id=$1", [id]);
    }

    return success(res, null, "Logged out");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error logging out");
  }
});

module.exports = router;
