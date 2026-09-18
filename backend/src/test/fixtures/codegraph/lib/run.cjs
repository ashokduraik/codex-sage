const { greet } = require('./greet.cjs');
module.exports = { run: () => greet('world') };
