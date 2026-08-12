// src/middleware/validate.js
// Request validation using Zod schemas.
// Usage:
//   router.post('/clients', validate(clientSchemas.create), handler);
//   router.put('/clients/:id', validate(clientSchemas.update), handler);

const logger = require('../lib/logger');

function validate(schemas) {
  return function(req, res, next) {
    try {
      if (schemas.body)   req.body   = schemas.body.parse(req.body);
      if (schemas.query)  req.query  = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      const issues = err && err.issues ? err.issues : [];
      const fields = {};
      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        fields[issue.path.join('.')] = issue.message;
      }

      logger.warn({
        path: req.path,
        method: req.method,
        fields: fields,
      }, 'Validation failed');

      return res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Invalid request',
          fields: fields,
        },
      });
    }
  };
}

module.exports = { validate };
