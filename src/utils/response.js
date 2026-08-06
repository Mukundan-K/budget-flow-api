const HttpStatus = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500,
};

function success(res, data = null, message = "Success", statusCode = HttpStatus.OK) {
  return res.status(statusCode).json({
    status: statusCode,
    message,
    data,
  });
}

function created(res, data = null, message = "Created successfully") {
  return success(res, data, message, HttpStatus.CREATED);
}

function error(res, message = "Internal server error", statusCode = HttpStatus.INTERNAL_SERVER_ERROR, data = null) {
  return res.status(statusCode).json({
    status: statusCode,
    message,
    data,
  });
}

function badRequest(res, message = "Bad request", data = null) {
  return error(res, message, HttpStatus.BAD_REQUEST, data);
}

function unauthorized(res, message = "Unauthorized", data = null) {
  return error(res, message, HttpStatus.UNAUTHORIZED, data);
}

function forbidden(res, message = "Forbidden", data = null) {
  return error(res, message, HttpStatus.FORBIDDEN, data);
}

function notFound(res, message = "Not found", data = null) {
  return error(res, message, HttpStatus.NOT_FOUND, data);
}

function conflict(res, message = "Conflict", data = null) {
  return error(res, message, HttpStatus.CONFLICT, data);
}

function serverError(res, message = "Internal server error", data = null) {
  return error(res, message, HttpStatus.INTERNAL_SERVER_ERROR, data);
}

module.exports = {
  HttpStatus,
  success,
  created,
  error,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  serverError,
};
