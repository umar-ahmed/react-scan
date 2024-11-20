import {
  PanResponder,
  UIManager,
  View,
  Text as RNText,
  Pressable,
  Animated,
} from 'react-native';
import { Fiber } from 'react-reconciler';
import { instrument, Render } from '../instrumentation';
import { getNearestHostFiber } from '../instrumentation/fiber';
import { Measurement, MeasurementValue, ReactScanInternals } from '../..';
import { getCopiedActiveOutlines, getLabelText } from '../utils';

import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { Dimensions, Platform } from 'react-native';
import {
  Canvas,
  Group,
  Rect,
  Text,
  matchFont,
} from '@shopify/react-native-skia';
import { useSharedValue, useDerivedValue } from 'react-native-reanimated';
import { PendingOutline } from '../web/outline';

export const genId = (): string => {
  const timeStamp = Date.now().toString(36);
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const randomPart = Array.from(array)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${timeStamp}-${randomPart}`;
};

export const measureFiber = (
  fiber: any,
  callback?: (coords: MeasurementValue | null) => void,
): Promise<MeasurementValue | null> => {
  return new Promise((resolve) => {
    const handleMeasurement = (
      width: number,
      height: number,
      pageX: number,
      pageY: number,
    ) => {
      const coords: MeasurementValue = { width, height, pageX, pageY };
      callback?.(coords);
      resolve(coords);
    };

    let measurableNode = fiber;
    while (measurableNode) {
      if (measurableNode.stateNode?.canonical?.nativeTag) {
        UIManager.measure(
          measurableNode.stateNode.canonical.nativeTag,
          handleMeasurement,
        );
        return;
      }

      // // this probably doesn't do anything
      // if (measurableNode.stateNode?._nativeTag) {
      //   // console.log("B");
      //   UIManager.measure(
      //     measurableNode.stateNode._nativeTag,
      //     handleMeasurement
      //   );
      //   return;
      // }

      // // this probably doesn't do anything
      // if (measurableNode.stateNode?.measureInWindow) {
      //   // console.log("C");
      //   measurableNode.stateNode.measureInWindow(
      //     (x: number, y: number, width: number, height: number) => {
      //       // measureInWindow doesn't provide pageX/pageY, so they're same as x/y
      //       handleMeasurement(x, y, width, height, x, y);
      //     }
      //   );
      //   return;
      // }

      // If no measurement method found, try the first child
      measurableNode = measurableNode.child;
    }

    // If we couldn't find any measurable node
    callback?.(null);
    resolve(null);
  });
};

const getKey = (measurement: MeasurementValue) => {
  return `${measurement.pageX}-${measurement.pageY}-${measurement.width}-${measurement.height}`;
};
export const assertNative = (measurement: Measurement) => {
  if (measurement.kind !== 'native') {
    throw new Error('native invariant');
  }
  return measurement;
};

const updateOutlines = async (fiber: Fiber, render: Render) => {
  const hostFiber = getNearestHostFiber(fiber);
  if (!hostFiber) {
    return null;
  }
  const measurement = await measureFiber(fiber);
  if (!measurement) {
    return null;
  }

  if (!measurement.pageX) {
    // weird case come back to this
    return null;
  }

  const existingOutline = ReactScanInternals.activeOutlines.find(
    ({ outline }) => {
      return (
        getKey(assertNative(outline.cachedMeasurement).value) ===
        getKey(measurement)
      );
    },
  );

  // if an outline exists we just update the renders
  if (existingOutline) {
    existingOutline.outline.renders.push(render);
    existingOutline.text = getLabelText(
      existingOutline.outline.renders,
      'native',
    );
    existingOutline.updatedAt = Date.now();
    ReactScanInternals.activeOutlines = getCopiedActiveOutlines();
  } else {
    // create the outline for the first time
    const measuredFiber = await measureFiber(fiber);
    if (!measuredFiber) {
      return;
    }
    const newOutline: PendingOutline = {
      cachedMeasurement: {
        kind: 'native',
        value: measuredFiber,
      },
      fiber: new WeakRef(fiber),
      renders: [render],
    };
    ReactScanInternals.activeOutlines.push({
      outline: newOutline,
      alpha: null!,
      frame: null!,
      totalFrames: null!,
      id: genId(),
      resolve: () => {
        // resolve();
        // todo, update this,
        // options.onPaintFinish?.(outline);
      },
      text: getLabelText(newOutline.renders, 'native'),
      updatedAt: Date.now(),
      color: null!, // not used for now
    });
    // tell useSes there's new data
    ReactScanInternals.activeOutlines = getCopiedActiveOutlines();
  }
};

export const instrumentNative = () => {
  const options = ReactScanInternals.options;
  instrument({
    onCommitStart() {
      options.onCommitStart?.();
    },
    async onRender(fiber, render) {
      // console.log('render', render.name);
      // port over metadata stuff later
      options.onRender?.(fiber, render);
      updateOutlines(fiber, render);
    },
    onCommitFinish() {
      options.onCommitFinish?.();
    },
  });
};

// dont run this here
instrumentNative();

const useCleanupActiveLines = () => {
  const isPaused = useSyncExternalStore(
    (listener) => ReactScanInternals.subscribe('isPaused', listener),
    () => ReactScanInternals.isPaused,
  );
  useEffect(() => {
    const interval = setInterval(() => {
      if (isPaused) return;

      const newActive = ReactScanInternals.activeOutlines.filter(
        (x) => Date.now() - x.updatedAt < 300,
      );
      if (newActive.length !== ReactScanInternals.activeOutlines.length) {
        ReactScanInternals.set('activeOutlines', newActive);
      }
    }, 200);
    return () => {
      clearInterval(interval);
    };
  }, [isPaused]);
};

export const ReactNativeScanEntryPoint = () => {
  useCleanupActiveLines();
  const isPaused = useSyncExternalStore(
    (listener) => ReactScanInternals.subscribe('isPaused', listener),
    () => ReactScanInternals.isPaused,
  );

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

  return (
    <>
      {!isPaused && <ReactNativeScan id="react-scan-no-traverse" />}

      <Animated.View
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
          onPress={() => (ReactScanInternals.isPaused = !isPaused)}
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

const ReactNativeScan = ({ id: _ }: { id: string }) => {
  const { width, height } = Dimensions.get('window');
  const outlines = useSyncExternalStore(
    (listener) => ReactScanInternals.subscribe('activeOutlines', listener),
    () => ReactScanInternals.activeOutlines,
  );
  const opacity = useSharedValue(1);
  const animatedOpacity = useDerivedValue(() => opacity.value);
  const font = matchFont({
    fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
    fontSize: 11,
    fontWeight: 'bold',
  });

  const getTextWidth = (text: string) => {
    return (text || 'unknown').length * 7;
  };

  return (
    <Canvas
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width,
        height,
        zIndex: 999999,
        pointerEvents: 'none',
      }}
    >
      <Group opacity={animatedOpacity}>
        {outlines.map((render) => {
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
                  assertNative(render.outline.cachedMeasurement).value.pageY - 5
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
