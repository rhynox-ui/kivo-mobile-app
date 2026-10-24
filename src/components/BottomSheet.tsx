import React, {useEffect, useRef} from 'react';
import {Animated, Dimensions, KeyboardAvoidingView, PanResponder, StyleSheet, View} from 'react-native';
import {KivoModal} from './KivoModal';
import {kivoTheme} from '../theme/kivoTheme';

const SCREEN_HEIGHT = Dimensions.get('window').height;
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.8;

export function BottomSheet({visible,onClose,children,maxHeight}:{visible:boolean;onClose:()=>void;children:React.ReactNode;maxHeight?:number}) {
  const translateY = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    translateY.setValue(SCREEN_HEIGHT);
    Animated.parallel([
      Animated.spring(translateY,{toValue:0,useNativeDriver:true,bounciness:4}),
      Animated.timing(backdropOpacity,{toValue:1,duration:200,useNativeDriver:true}),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = () => Animated.parallel([
    Animated.timing(translateY,{toValue:SCREEN_HEIGHT,duration:220,useNativeDriver:true}),
    Animated.timing(backdropOpacity,{toValue:0,duration:200,useNativeDriver:true}),
  ]).start(onClose);

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder:(_,g)=>g.dy>4&&Math.abs(g.dy)>Math.abs(g.dx),
    onPanResponderMove:(_,g)=>{if(g.dy>0)translateY.setValue(g.dy);},
    onPanResponderRelease:(_,g)=>{
      if(g.dy>DISMISS_DISTANCE||g.vy>DISMISS_VELOCITY) close();
      else Animated.spring(translateY,{toValue:0,useNativeDriver:true,bounciness:4}).start();
    },
  })).current;

  if (!visible) return null;
  return (
    <KivoModal visible transparent animationType="none" onRequestClose={close}>
      {/* The keypad must not cover the sheet's inputs (Convert amount…). The
          modal draws edge-to-edge, so the window may not resize for the
          keyboard: padding by the measured overlap lifts the sheet either way. */}
      <KeyboardAvoidingView style={styles.overlay} behavior="padding">
        <Animated.View style={[styles.backdrop,{opacity:backdropOpacity}]}>
          <View style={StyleSheet.absoluteFill} onTouchEnd={close}/>
        </Animated.View>
        <Animated.View style={[styles.sheet,{maxHeight:maxHeight??SCREEN_HEIGHT*0.85,paddingBottom:28,transform:[{translateY}]}]}>
          <View {...panResponder.panHandlers} style={styles.handleArea}><View style={styles.handle}/></View>
          {children}
        </Animated.View>
      </KeyboardAvoidingView>
    </KivoModal>
  );
}

const styles=StyleSheet.create({
  overlay:{flex:1,justifyContent:'flex-end'},
  backdrop:{position:'absolute',top:0,right:0,bottom:0,left:0,backgroundColor:'rgba(0,0,0,0.72)'},
  sheet:{backgroundColor:kivoTheme.colors.surface,borderTopLeftRadius:26,borderTopRightRadius:26,borderWidth:1,borderColor:kivoTheme.colors.border,borderBottomWidth:0,paddingHorizontal:20},
  handleArea:{alignItems:'center',paddingVertical:10},
  handle:{width:36,height:4,borderRadius:2,backgroundColor:kivoTheme.colors.border},
});