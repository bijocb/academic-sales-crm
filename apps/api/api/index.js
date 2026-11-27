// Vercel function: every request is rewritten here (see vercel.json) and served by Nest.
module.exports = require('../dist/serverless.js').default;
