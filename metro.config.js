const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

// The trading engine (./trading) and the social/profile rules (./shared)
// live in this repo as the mobile app's own snapshot. Their imports
// (e.g. viem) resolve from this app's node_modules.
module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    extraNodeModules: {
      '@kivo/trading': path.join(__dirname, 'trading'),
      '@kivo/shared': path.join(__dirname, 'shared'),
    },
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    unstable_enablePackageExports: true,
  },
});
