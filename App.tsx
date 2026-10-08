import React from 'react';
import { StatusBar } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { kivoTheme } from './src/theme/kivoTheme';
import { CrashBoundary, installCrashReporter } from './src/debug/crashReporter';

installCrashReporter();

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
