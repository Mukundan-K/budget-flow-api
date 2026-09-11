const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "30d";

function durationToMs(value) {
  const raw = String(value || "30d").trim();
  const match = raw.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit];
}

function generateAccessToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
    },
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    }
  );
}

function generateRefreshToken(user, jti) {
  if (!jti) {
    throw new Error("refresh token jti is required");
  }
  return jwt.sign(
    {
      id: user.id,
      jti,
      tv: crypto.randomUUID(),
    },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    }
  );
}

function tokenPair(user, jti) {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user, jti),
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  };
}

module.exports = {
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  durationToMs,
  generateAccessToken,
  generateRefreshToken,
  tokenPair,
};
