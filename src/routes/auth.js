const express = require("express");
const passport = require("passport");
const jwt = require("jsonwebtoken");
const pool = require("../db");

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
    return res.status(401).json({
      message: "Refresh token missing",
    });
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
      return res.status(403).json({
        message: "User not found",
      });
    }

    if (user.rows[0].refresh_token !== refreshToken) {
      return res.status(403).json({
        message: "Invalid refresh token",
      });
    }

    const newAccessToken = generateAccessToken(user.rows[0]);

    res.json({
      accessToken: newAccessToken,
    });

  } catch (err) {

    return res.status(403).json({
      message: "Invalid refresh token",
    });
  }
});

router.post("/logout", async (req, res) => {

  const { userId } = req.body;

  await pool.query(
    "UPDATE users SET refresh_token=NULL WHERE id=$1",
    [userId]
  );

  res.json({
    message: "Logged out",
  });
});

module.exports = router;