'use strict';

module.exports = {
  ...require('./lib/FilesystemCache.js'),
  ...require('./lib/PlacementSource.js'),
  ...require('./lib/SharedCache.js'),
};
