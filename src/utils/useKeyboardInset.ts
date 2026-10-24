import { useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, Platform, useWindowDimensions } from 'react-native';

/**
 * How much of the screen the on-screen keyboard covers that the window did
 * NOT already shrink for. iOS never resizes the window, so that is the whole
 * keyboard. Android with edge-to-edge (gradle edgeToEdgeEnabled) often draws
 * the keyboard over the app without resizing it, even with adjustResize, so
 * only the part native resizing missed is counted. Add it as bottom padding
 * to a scrolling form, then scroll the focused field into view.
 */
export function useKeyboardInset(): number {
  const initialWindowHeight = useRef(Dimensions.get('window').height);
  const { height: windowHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, event => setKeyboardHeight(event.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  if (Platform.OS === 'ios') return keyboardHeight;
  return Math.max(0, keyboardHeight - Math.max(0, initialWindowHeight.current - windowHeight));
}
