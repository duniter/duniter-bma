"use strict";

const co = require('co');
const stack = require('duniter').statics.autoStack();

co(function*() {
  yield stack.executeStack(process.argv);
  process.exit();
});
