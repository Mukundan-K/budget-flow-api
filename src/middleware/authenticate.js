const jwt = require("jsonwebtoken");
const { unauthorized } = require("../utils/response");

function authenticate(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return unauthorized(res, "Access token missing");
  }

  const token = header.slice(7);

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return unauthorized(res, "Invalid or expired access token");
  }
}

module.exports = authenticate;
