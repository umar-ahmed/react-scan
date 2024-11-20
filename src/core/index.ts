import type { Fiber, FiberRoot } from 'react-reconciler';
import * as React from 'react';
import { instrument, type Render } from './instrumentation/index';
import { createStore } from './utils';
import {
  ActiveOutline,
  flushOutlines,
  getOutline,
  PendingOutline,
} from './web/outline';
import { createOverlay } from './web/index';
import { logIntro } from './web/log';
import { createToolbar } from './web/toolbar';
import { playGeigerClickSound } from './web/geiger';
import { createPerfObserver } from './web/perf-observer';

interface Options {
  /**
   * Enable/disable scanning
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Include children of a component applied with withScan
   *
   * @default true
   */
  includeChildren?: boolean;

  /**
   * Run in production
   *
   * @default false
   */
  runInProduction?: boolean;

  /**
   * Enable/disable geiger sound
   *
   * @default true
   */
  playSound?: boolean;

  /**
   * Log renders to the console
   *
   * @default false
   */
  log?: boolean;

  /**
   * Show toolbar bar
   *
   * @default true
   */
  showToolbar?: boolean;

  /**
   * Long task threshold in milliseconds, only show
   * when main thread is blocked for longer than this
   *
   * @default 50
   */
  longTaskThreshold?: number;

  /**
   * Clear aggregated fibers after this time in milliseconds
   *
   * @default 5000
   */
  resetCountTimeout?: number;

  /**
   * Maximum number of renders for red indicator
   *
   * @default 20
   */
  maxRenders?: number;

  /**
   * Report data to getReport()
   *
   * @default false
   */
  report?: boolean;

  onCommitStart?: () => void;
  onRender?: (fiber: Fiber, render: Render) => void;
  onCommitFinish?: () => void;
  onPaintStart?: (outline: PendingOutline) => void;
  onPaintFinish?: (outline: PendingOutline) => void;
}

interface Internals {
  onCommitFiberRoot: (rendererID: number, root: FiberRoot) => void;
  isProd: boolean;
  isInIframe: boolean;
  isPaused: boolean;
  componentAllowList: WeakMap<React.ComponentType<any>, Options> | null;
  options: Options;
  scheduledOutlines: PendingOutline[];
  activeOutlines: ActiveOutline[];
  reportData: Record<
    string,
    {
      count: number;
      time: number;
      renders: Render[];
    }
  >;
}

export type MeasurementValue = {
  width: number;
  height: number;
  pageX: number;
  pageY: number;
};
export type Measurement =
  | { kind: 'dom'; value: DOMRect }
  | {
      kind: 'native';
      value: MeasurementValue;
    };

export const ReactScanInternals = createStore<Internals>({
  onCommitFiberRoot: (_rendererID: number, _root: FiberRoot): void => {
    /**/
  },
  isProd: null!, // todo
  // get isProd() {
  //   return (
  //     '_self' in React.createElement('div') &&
  //     !ReactScanInternals.options.runInProduction
  //   );
  // },
  isInIframe: window.self !== window.top,
  isPaused: false,
  componentAllowList: null,
  options: {
    enabled: true,
    includeChildren: true,
    runInProduction: false,
    playSound: false,
    log: false,
    showToolbar: true,
    longTaskThreshold: 50,
    report: false,
  },
  reportData: {},
  scheduledOutlines: [],
  activeOutlines: [],
});

export const getReport = () => ReactScanInternals.reportData;

export const setOptions = (options: Options) => {
  ReactScanInternals.options = {
    ...ReactScanInternals.options,
    ...options,
  };
};

export const getOptions = () => ReactScanInternals.options;

let inited = false;

export const start = () => {
  if (inited) return;
  inited = true;
  const { options } = ReactScanInternals;
  const ctx = createOverlay();
  const toolbar = options.showToolbar ? createToolbar() : null;
  const perfObserver = createPerfObserver();
  const audioContext =
    typeof window !== 'undefined'
      ? new (window.AudioContext ||
          // @ts-expect-error -- This is a fallback for Safari
          window.webkitAudioContext)()
      : null;

  if (!ctx) return;
  logIntro();

  globalThis.__REACT_SCAN__ = {
    ReactScanInternals,
  };

  instrument({
    onCommitStart() {
      options.onCommitStart?.();
    },
    onRender(fiber, render) {
      options.onRender?.(fiber, render);
      const outline = getOutline(fiber, render);
      if (!outline) return;
      ReactScanInternals.scheduledOutlines.push(outline);

      if (options.playSound && audioContext) {
        const renderTimeThreshold = 10;
        const amplitude = Math.min(
          1,
          (render.time - renderTimeThreshold) / (renderTimeThreshold * 2),
        );
        playGeigerClickSound(audioContext, amplitude);
      }

      if (render.name) {
        const report = ReactScanInternals.reportData[render.name];
        if (report) {
          report.renders.push(render);
        }
        ReactScanInternals.reportData[render.name] = {
          count: (report?.count ?? 0) + render.count,
          time: (report?.time ?? 0) + render.time,
          renders: report?.renders || [],
        };
      }

      requestAnimationFrame(() => {
        flushOutlines(ctx, new Map(), toolbar, perfObserver);
      });
    },
    onCommitFinish() {
      options.onCommitFinish?.();
    },
  });
};

export const withScan = <T>(
  component: React.ComponentType<T>,
  options: Options = {},
) => {
  setOptions(options);
  const { isInIframe, isProd, componentAllowList } = ReactScanInternals;
  if (isInIframe || isProd || options.enabled === false) return component;
  if (!componentAllowList) {
    ReactScanInternals.componentAllowList = new WeakMap<
      React.ComponentType<any>,
      Options
    >();
  }
  if (componentAllowList) {
    componentAllowList.set(component, { ...options });
  }

  start();

  return component;
};

export const scan = (options: Options = {}) => {
  setOptions(options);
  const { isInIframe, isProd } = ReactScanInternals;
  if (isInIframe || isProd || options.enabled === false) return;

  start();
};
