// Polyfills first: Hermes has no TextEncoder/TextDecoder, Buffer or
// crypto.getRandomValues, which viem and the wallet code need at load time.
import './src/polyfills';
import React from 'react';
import { AppRegistry } from 'react-native';
import { CrashBoundary, CrashScreen, installCrashReporter } from './src/debug/crashReporter';

installCrashReporter();

// App is required (not imported) so an error while loading it is caught and
// shown instead of closing the app.
let Root;
try {
  const App = require('./App').default;
  Root = () => React.createElement(CrashBoundary, null, React.createElement(App));
} catch (error) {
  Root = () => React.createElement(CrashScreen, { error });
}

AppRegistry.registerComponent('Kivo', () => Root);
