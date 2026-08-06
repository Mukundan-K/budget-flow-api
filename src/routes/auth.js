const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const authenticate = require("../middleware/authenticate");
const {
  success,
  unauthorized,
  forbidden,
  notFound,
  serverError,
} = require("../utils/response");

const router = express.Router();

function generateAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
    },
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: "15m",
    }
  );
}

function generateRefreshToken(user) {
  return jwt.sign(
    {
      id: user.id,
    },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: "30d",
    }
  );
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
    const accessToken = generateAccessToken(req.user);
    const refreshToken = generateRefreshToken(req.user);

    await pool.query(
      "UPDATE users SET refresh_token=$1 WHERE id=$2",
      [refreshToken, req.user.id]
    );

    res.redirect(
      `${process.env.FRONTEND_URL}/login?accessToken=${accessToken}&refreshToken=${refreshToken}`
    );
  }
);

router.post("/refresh-token", async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return unauthorized(res, "Refresh token missing");
  }

  try {
    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET
    );

    const user = await pool.query(
      "SELECT * FROM users WHERE id=$1",
      [decoded.id]
    );

    if (user.rows.length === 0) {
      return forbidden(res, "User not found");
    }

    if (user.rows[0].refresh_token !== refreshToken) {
      return forbidden(res, "Invalid refresh token");
    }

    const newAccessToken = generateAccessToken(user.rows[0]);

    return success(
      res,
      { accessToken: newAccessToken },
      "Access token refreshed successfully"
    );
  } catch (err) {
    return forbidden(res, "Invalid refresh token");
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
    const { userId } = req.body;

    if (!userId) {
      return unauthorized(res, "userId is required");
    }

    await pool.query(
      "UPDATE users SET refresh_token=NULL WHERE id=$1",
      [userId]
    );

    return success(res, null, "Logged out");
  } catch (err) {
    console.error(err);
    return serverError(res, "Error logging out");
  }
});

module.exports = router;
