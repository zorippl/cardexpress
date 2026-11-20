const fs = require('node:fs/promises');
const { constants } = require('node:fs');

async function identifyLocation(path) {
  const real = await fs.realpath(path);
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error('该路径不是文件夹');
  await fs.access(real, constants.R_OK | constants.X_OK);
  return { path, real, dev: stat.dev, ino: stat.ino };
}

async function isSameLocation(location) {
  try {
    const actual = await identifyLocation(location.path);
    return actual.real === location.real && actual.dev === location.dev && actual.ino === location.ino;
  } catch {
    return false;
  }
}

module.exports = { identifyLocation, isSameLocation };
