/* eslint-env node */
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rootDirPattern = (dirName) =>
  new RegExp(`^${escapeRegExp(path.join(__dirname, dirName))}(?:[/\\\\]|$)`);

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

const defaultBlockList = config.resolver?.blockList
  ? Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : [config.resolver.blockList]
  : [];

config.resolver = {
  ...config.resolver,
  blockList: [
    ...defaultBlockList,
    // Ignore transient Bun staging folders (e.g. node_modules/.bun-tmp-*/android) so Metro's
    // NodeWatcher never crashes with ENOENT when Bun creates or removes them.
    /(?:^|[/\\])\.bun-tmp-[^/\\]+(?:[/\\]|$)/,
    rootDirPattern('.playwright-cli'),
    rootDirPattern('.expo'),
    rootDirPattern('dist'),
    rootDirPattern('dist-pages'),
    rootDirPattern('dist-root'),
  ],
};

module.exports = config;
