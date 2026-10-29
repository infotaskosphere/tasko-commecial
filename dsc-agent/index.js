'use strict';

// Older installs and docs start the agent with `node index.js`. It used to be a
// separate, smaller server with its own (out of date) list of allowed
// websites; it now starts the same agent as agent.js.
module.exports = require('./agent');
