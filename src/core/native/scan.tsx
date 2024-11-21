import {
  Animated,
  PanResponder,
  Pressable,
  Text as RNText,
  ScaledSize,
  View,
} from 'react-native';
import { Measurement, MeasurementValue, ReactScanInternals } from '../..';

import {
  Canvas,
  Group,
  matchFont,
  Rect,
  Text,
} from '@shopify/react-native-skia';
import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Dimensions, Platform } from 'react-native';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { assertNative, instrumentNative } from '.';

// can't use useSyncExternalStore for compat
const useIsPaused = () => {
  const [isPaused, setIsPaused] = useState(ReactScanInternals.isPaused);
  useEffect(() => {
    ReactScanInternals.subscribe('isPaused', (isPaused) =>
      setIsPaused(isPaused),
    );
  }, []);

  return isPaused;
};

export const ReactNativeScanEntryPoint = () => {
  if (ReactScanInternals.isProd) {
    return null; // todo: better no-op
  }

  useEffect(() => {
    if (!ReactScanInternals.isProd) {
      instrumentNative(); // cleanup?
    }
  }, []);
  const isPaused = useIsPaused();

  const pan = useRef(new Animated.ValueXY()).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        pan.setOffset({
          // @ts-expect-error
          x: pan.x._value,
          // @ts-expect-error
          y: pan.y._value,
        });
      },
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: () => {
        pan.flattenOffset();
      },
    }),
  ).current;

  useEffect(() => {
    const interval = setInterval(() => {
      if (isPaused) return;

      const newActive = ReactScanInternals.activeOutlines.filter(
        (x) => Date.now() - x.updatedAt < 500,
      );
      if (newActive.length !== ReactScanInternals.activeOutlines.length) {
        ReactScanInternals.set('activeOutlines', newActive);
      }
    }, 200);
    return () => {
      clearInterval(interval);
    };
  }, [isPaused]);

  return (
    <>
      {!isPaused && <ReactNativeScan id="react-scan-no-traverse" />}

      <Animated.View
        id="react-scan-no-traverse"
        style={{
          position: 'absolute',
          bottom: 20,
          right: 20,
          zIndex: 999999,
          transform: pan.getTranslateTransform(),
        }}
        {...panResponder.panHandlers}
      >
        <Pressable
          onPress={() =>
            (ReactScanInternals.isPaused = !ReactScanInternals.isPaused)
          }
          style={{
            backgroundColor: !isPaused
              ? 'rgba(88, 82, 185, 0.9)'
              : 'rgba(88, 82, 185, 0.5)',
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 4,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: !isPaused ? '#4ADE80' : '#666',
            }}
          />
          <RNText
            style={{
              color: 'white',
              fontSize: 14,
              fontWeight: 'bold',
              fontFamily: Platform.select({
                ios: 'Courier',
                default: 'monospace',
              }),
            }}
          >
            React Scan
          </RNText>
        </Pressable>
      </Animated.View>
    </>
  );
};
const dimensions = Dimensions.get('window');
const isVisible = (x: number, y: number) => {
  return x >= 0 && x <= dimensions.width && y >= 0 && y <= dimensions.height;
};
const font = matchFont({
  fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
  fontSize: 11,
  fontWeight: 'bold',
});
const getTextWidth = (text: string) => {
  return (text || 'unknown').length * 7;
};
const ReactNativeScan = ({ id: _ }: { id: string }) => {
  const opacity = useSharedValue(1);
  // todo: polly fill
  const outlines = useSyncExternalStore(
    (listener) =>
      ReactScanInternals.subscribe('activeOutlines', (value) => {
        // animations destroy UI thread on heavy updates, probably not worth it
        // opacity.value = 1;
        // opacity.value = withTiming(0, {
        //   duration: 500
        // })
        listener();
      }),
    () => ReactScanInternals.activeOutlines,
  );
  // );
  const animatedOpacity = useDerivedValue(() => opacity.value);

  return (
    <Canvas
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: dimensions.width,
        height: dimensions.height,
        zIndex: 999999,
        pointerEvents: 'none',
      }}
    >
      <Group opacity={animatedOpacity}>
        {outlines
          // we can maybe take this out of render if Dimensions.get is cheap
          .filter(({ outline }) => {
            const measurement = assertNative(outline.cachedMeasurement).value;
            const vis = isVisible(measurement.x, measurement.y);
            return vis;
          })
          .map((render) => {
            const textWidth = getTextWidth(render.text ?? 'unknown');
            const labelPadding = 4;
            const labelWidth = textWidth + labelPadding * 2;
            const labelHeight = 12;
            return (
              <Group key={render.id}>
                <Rect
                  x={assertNative(render.outline.cachedMeasurement).value.pageX}
                  y={assertNative(render.outline.cachedMeasurement).value.pageY}
                  width={
                    assertNative(render.outline.cachedMeasurement).value.width
                  }
                  height={
                    assertNative(render.outline.cachedMeasurement).value.height
                  }
                  color="rgba(88, 82, 185, 0.1)"
                />
                <Rect
                  x={assertNative(render.outline.cachedMeasurement).value.pageX}
                  y={assertNative(render.outline.cachedMeasurement).value.pageY}
                  width={
                    assertNative(render.outline.cachedMeasurement).value.width
                  }
                  height={
                    assertNative(render.outline.cachedMeasurement).value.height
                  }
                  color="rgba(147, 141, 255, 0.6)"
                  style="stroke"
                  strokeWidth={1}
                />
                <Rect
                  x={assertNative(render.outline.cachedMeasurement).value.pageX}
                  y={
                    assertNative(render.outline.cachedMeasurement).value.pageY -
                    labelHeight -
                    2
                  }
                  width={labelWidth}
                  height={labelHeight}
                  color="rgba(88, 82, 185, 0.9)"
                />
                <Text
                  x={
                    assertNative(render.outline.cachedMeasurement).value.pageX +
                    labelPadding
                  }
                  y={
                    assertNative(render.outline.cachedMeasurement).value.pageY -
                    5
                  }
                  text={render.text || 'unknown'}
                  font={font}
                  color="#FFFFFF"
                />
              </Group>
            );
          })}
      </Group>
    </Canvas>
  );
};
