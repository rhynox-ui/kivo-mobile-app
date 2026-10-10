import React from 'react';
import {Modal, StyleSheet, View, type ModalProps} from 'react-native';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';

// The app draws edge-to-edge on Android, so a plain <Modal> can put its
// bottom panel under the system navigation bar (buttons like Close end up
// behind it). This wrapper makes the modal window edge-to-edge too and keeps
// its content inside the real safe area of that window.
function Inset({children}: {children: React.ReactNode}) {
  const insets = useSafeAreaInsets();
  return <View style={[styles.fill, {paddingTop: insets.top, paddingBottom: insets.bottom}]}>{children}</View>;
}

export function KivoModal({children, ...props}: ModalProps & {children?: React.ReactNode}) {
  return (
    <Modal statusBarTranslucent navigationBarTranslucent {...props}>
      <SafeAreaProvider>
        <Inset>{children}</Inset>
      </SafeAreaProvider>
    </Modal>
  );
}

const styles = StyleSheet.create({fill: {flex: 1}});
