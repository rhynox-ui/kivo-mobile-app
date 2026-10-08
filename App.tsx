import React from 'react';
import { StatusBar } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { kivoTheme } from './src/theme/kivoTheme';
import { CrashBoundary, installCrashReporter } from './src/debug/crashReporter';
import { configureRelayEndpoints } from './trading/core/relayQuote';
import { configureGaslessStatusUrl } from './trading/kivo/gasless';

installCrashReporter();

// Match Mango Pro's gasless architecture: quotes and sponsored execution go
// through Kivo's backend, which keeps the Relay sponsorship key server-side.
configureRelayEndpoints({
  quoteUrl: 'https://kivo-web.pages.dev/api/relay/quote',
  sponsorship: true,
});
configureGaslessStatusUrl('https://kivo-web.pages.dev/api/relay/config');

export default function App() {
  return (
    <SafeAreaProvider>
      <CrashBoundary>
      <SafeAreaView
        edges={['top', 'bottom']}
        style={{ flex: 1, backgroundColor: kivoTheme.colors.background }}
      >
        <StatusBar
          barStyle="light-content"
        />
        <RootNavigator />
      </SafeAreaView>
      </CrashBoundary>
    </SafeAreaProvider>
  );
}
