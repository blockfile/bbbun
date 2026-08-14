'use strict';
const { EventEmitter } = require('node:events');
const bus = new EventEmitter();
bus.setMaxListeners(100); // one listener per connected SSE client
module.exports = bus;
