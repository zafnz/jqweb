/* Builds jqweb and renders the pages before any spec runs. */

'use strict';

const { renderAll } = require('./pages.js');

module.exports = function globalSetup() {
  renderAll();
};
