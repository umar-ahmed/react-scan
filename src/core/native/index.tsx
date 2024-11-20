import {
  Animated,
  PanResponder,
  Pressable,
  Text as RNText,
  UIManager,
  View,
} from 'react-native';
import { Fiber } from 'react-reconciler';
import { Measurement, MeasurementValue, ReactScanInternals } from '../..';
import { instrument, Render } from '../instrumentation';
import { getNearestHostFiber } from '../instrumentation/fiber';
import { getCopiedActiveOutlines, getLabelText } from '../utils';

import {
  Canvas,
  Group,
  matchFont,
  Rect,
  Text,
} from '@shopify/react-native-skia';
import React, { useEffect, useRef, useState } from 'react';
import { Dimensions, Platform } from 'react-native';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';
import { ActiveOutline, PendingOutline } from '../web/outline';

export const genId = () => {
  const timeStamp: number = performance.now();
  const randomNum: number = Math.floor(Math.random() * 1000);
  return `${timeStamp}-${randomNum}`;
};

export const measureFiber = (
  fiber: any,
  callback?: (coords: MeasurementValue | null) => void,
): Promise<MeasurementValue | null> => {
  return new Promise((resolve) => {
    const handleMeasurement = (
      x: number,
      y: number,
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

      // this probably doesn't do anything
      if (measurableNode.stateNode?._nativeTag) {
        // console.log("B");
        UIManager.measure(
          measurableNode.stateNode._nativeTag,
          handleMeasurement,
        );
        return;
      }

      // this probably doesn't do anything
      if (measurableNode.stateNode?.measureInWindow) {
        // console.log("C");
        measurableNode.stateNode.measureInWindow(
          (x: number, y: number, width: number, height: number) => {
            // measureInWindow doesn't provide pageX/pageY, so they're same as x/y
            handleMeasurement(x, y, width, height, x, y);
          },
        );
        return;
      }

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
    // console.log('nope');
    return null;
  }
  const measurement = await measureFiber(fiber);
  if (!measurement) {
    // console.log('nope1');
    return null;
  }

  if (!measurement.pageX) {
    // console.log('nope 2');
    // weird case come back to this
    return null;
  }

  // console.log('nice', measurement);
  try {
    const existingOutline = ReactScanInternals.activeOutlines.find(
      ({ outline }) => {
        return (
          getKey(assertNative(outline.cachedMeasurement).value) ===
          getKey(measurement)
        );
      },
    );
    // console.log('hi', existingOutline);

    // if an outline exists we just update the renders
    if (existingOutline) {
      existingOutline.outline.renders.push(render);
      existingOutline.text = getLabelText(
        existingOutline.outline.renders,
        'native',
      );
      existingOutline.updatedAt = Date.now();
      ReactScanInternals.activeOutlines = getCopiedActiveOutlines();
      // console.log('boo');
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
        fiber,
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
      // console.log('pushing outline', ReactScanInternals.activeOutlines.length);
      ReactScanInternals.activeOutlines = getCopiedActiveOutlines();
    }
  } catch (e) {
    console.log(e);
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
      // console.log('render', render.name);
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

export const ReactNativeScanEntryPoint = () => {
  console.log('running');
  const [isEnabled, setIsEnabled] = useState(true);
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
      if (!isEnabled) return;

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
  }, [isEnabled]);

  return (
    <>
      {isEnabled && <ReactNativeScan id="react-scan-no-traverse" />}

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
          onPress={() => setIsEnabled(!isEnabled)}
          style={{
            backgroundColor: isEnabled
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
              backgroundColor: isEnabled ? '#4ADE80' : '#666',
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
  // const [outlines, setOutlines] = React.useState<ActiveOutline[]>([]);
  // const outlines = useSyncExternalStore(
  //   (listener) => ReactScanInternals.subscribe('activeOutlines', (value) => {
  //     opacity.value = 1;
  //     opacity.value = withTiming(0, {
  //       duration: 300
  //     })
  //     listener()
  //   }),
  //   () => ReactScanInternals.activeOutlines,
  // );

  const [outlines, setOutlines] = useState<Array<ActiveOutline>>([]);

  useEffect(() => {
    setInterval(() => {
      setOutlines(ReactScanInternals.activeOutlines);
    }, 50);
  }, []);
  const opacity = useSharedValue(1);
  const animatedOpacity = useDerivedValue(() => opacity.value);
  const font = matchFont({
    fontFamily: Platform.select({ ios: 'Courier', default: 'monospace' }),
    fontSize: 11,
    fontWeight: 'bold',
  });

  // console.log('outlines', outlines.length);

  const getTextWidth = (text: string) => {
    return (text || 'unknown').length * 7;
  };
  console.log('render');
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
          // console.log('bruh',render.id);
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
