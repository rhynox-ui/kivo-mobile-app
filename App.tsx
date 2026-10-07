import React from 'react';
import { StatusBar } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context';
import { RootNavigator } from './src/navigation/RootNavigator';
import { kivoTheme } from './src/theme/kivoTheme';

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView
        edges={['top', 'bottom']}
        style={{ flex: 1, backgroundColor: kivoTheme.colors.background }}
      >
        <StatusBar
          barStyle="light-content"
        />
        <RootNavigator />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
