// server/asyncErrors.js
//
// Express 4 doesn't catch errors thrown inside async route handlers: the
// rejected promise goes unhandled and Node stops the whole server, so one
// bad request (an unexpected order, a typo in a URL) could take the site
// down for everyone. This sends those errors to the app's normal error
// handler instead (a 500 for that one request), the way Express 5 does.
// Required once from server/index.js before the routes are set up.

const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function handleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return original.call(this, req, res, next); // error-handling middleware: unchanged
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next);
  } catch (err) {
    next(err);
  }
};
