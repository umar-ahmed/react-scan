import type { Fiber, FiberRoot } from 'react-reconciler';
import * as React from 'react';
import { type NO_OP } from '../utils';
import { ReactScanInternals } from '../index';
import { getDisplayName, fastSerialize, getType } from './utils';
import {
  didFiberRender,
  getSelfTime,
  hasMemoCache,
  registerDevtoolsHook,
  shouldFilterFiber,
  traverseContexts,
  traverseFiber,
  traverseState,
} from './fiber';

// declare global {
//   interface Window {
//     __REACT_SCAN__?: {
//       ReactScanInternals: typeof ReactScanInternals;
//     };
//     reactScan: any;
//     __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
//       checkDCE: typeof NO_OP;
//       supportsFiber: boolean;
//       renderers: Map<number, any>;
//       onScheduleFiberRoot: typeof NO_OP;
//       onCommitFiberRoot: (rendererID: number, root: FiberRoot) => void;
//       onCommitFiberUnmount: typeof NO_OP;
//       inject: (renderer: any) => number;
//     };
//   }
// }

export interface Change {
  name: string;
  prevValue: unknown;
  nextValue: unknown;
  unstable: boolean;
}

export interface Render {
  type: 'props' | 'context';
  name: string | null;
  time: number;
  count: number;
  trigger: boolean;
  forget: boolean;
  changes: Change[] | null;
  label?: string;
}

const unstableTypes = ['function', 'object'];

// eslint-disable-next-line @typescript-eslint/ban-types
export const getPropsRender = (fiber: Fiber, type: Function): Render | null => {
  const changes: Change[] = [];

  const prevProps = fiber.alternate?.memoizedProps;
  const nextProps = fiber.memoizedProps;

  for (const propName in { ...prevProps, ...nextProps }) {
    const prevValue = prevProps?.[propName];
    const nextValue = nextProps?.[propName];

    if (
      Object.is(prevValue, nextValue) ||
      React.isValidElement(prevValue) ||
      React.isValidElement(nextValue) ||
      propName === 'children'
    ) {
      continue;
    }
    const change: Change = {
      name: propName,
      prevValue,
      nextValue,
      unstable: false,
    };
    changes.push(change);

    const prevValueString = fastSerialize(prevValue);
    const nextValueString = fastSerialize(nextValue);

    if (
      !unstableTypes.includes(typeof prevValue) ||
      !unstableTypes.includes(typeof nextValue) ||
      prevValueString !== nextValueString
    ) {
      continue;
    }

    change.unstable = true;
  }

  return {
    type: 'props',
    count: 1,
    trigger: false,
    changes,
    name: getDisplayName(type),
    time: getSelfTime(fiber),
    forget: hasMemoCache(fiber),
  };
};

export const getContextRender = (
  fiber: Fiber,
  // eslint-disable-next-line @typescript-eslint/ban-types
  type: Function,
): Render | null => {
  const changes: Change[] = [];

  const result = traverseContexts(fiber, (prevContext, nextContext) => {
    const prevValue = prevContext.memoizedValue;
    const nextValue = nextContext.memoizedValue;

    const change: Change = {
      name: '',
      prevValue,
      nextValue,
      unstable: false,
    };
    changes.push(change);

    const prevValueString = fastSerialize(prevValue);
    const nextValueString = fastSerialize(nextValue);

    if (
      unstableTypes.includes(typeof prevValue) &&
      unstableTypes.includes(typeof nextValue) &&
      prevValueString === nextValueString
    ) {
      change.unstable = true;
    }
  });

  if (!result) return null;

  return {
    type: 'context',
    count: 1,
    trigger: false,
    changes,
    name: getDisplayName(type),
    time: getSelfTime(fiber),
    forget: hasMemoCache(fiber),
  };
};

export const reportRender = (
  name: string,
  fiber: Fiber,
  renders: (Render | null)[],
) => {
  // TODO ROB: TURN ON REPORTING ASAP!!
  if (ReactScanInternals.options.report === false) return;

  const [reportFiber, report] = (() => {
    const currentFiberData = ReactScanInternals.reportData.get(fiber);
    if (currentFiberData) {
      return [fiber, currentFiberData] as const;
    }
    if (!fiber.alternate) {
      return [fiber, null] as const; // use the current fiber as a key
    }

    const alternateFiberData = ReactScanInternals.reportData.get(
      fiber.alternate,
    );
    return [fiber.alternate, alternateFiberData] as const;
  })();

  // const [reportFiber, report] =
  //   ([fiber, ReactScanInternals.reportData.get(fiber)] as const) ??
  //   (fiber.alternate &&
  //     ([
  //       ReactScanInternals.reportData.get(fiber.alternate),
  //       fiber.alternate,
  //     ] as const));
  if (report) {
    for (let i = 0, len = renders.length; i < len; i++) {
      const render = renders[i];
      if (render) {
        report.badRenders.push(render);
      }
    }
  }
  const time = getSelfTime(fiber) ?? 0;

  // ReactScanInternals.reportData[name] = {
  // count: (report?.count ?? 0) + 1,
  // time: (report?.time ?? 0) + time,
  // badRenders: report?.badRenders || [],
  // };
  ReactScanInternals.reportData.set(reportFiber, {
    count: (report?.count ?? 0) + 1,
    time: (report?.time ?? 0) + time,
    badRenders: report?.badRenders || [],
    // @ts-expect-error
    displayName: getDisplayName(fiber.type),
  });
  ReactScanInternals.emit('reportData', ReactScanInternals.reportData);
  console.log('SETTING', ReactScanInternals.reportData);
};

export const instrument = ({
  onCommitStart,
  onRender,
  onCommitFinish,
}: {
  onCommitStart: () => void;
  onRender: (fiber: Fiber, render: Render) => void;
  onCommitFinish: () => void;
}) => {
  const handleCommitFiberRoot = (_rendererID: number, root: FiberRoot) => {
    if (
      ReactScanInternals.isPaused ||
      ReactScanInternals.options.enabled === false
    ) {
      return;
    }
    onCommitStart();

    const recordRender = (fiber: Fiber) => {
      const type = getType(fiber.type);
      if (!type) return null;
      if (!didFiberRender(fiber)) return null;

      const propsRender = getPropsRender(fiber, type);
      const contextRender = getContextRender(fiber, type);

      let trigger = false;
      if (fiber.alternate) {
        const didStateChange = traverseState(fiber, (prevState, nextState) => {
          return !Object.is(prevState.memoizedState, nextState.memoizedState);
        });
        if (didStateChange) {
          trigger = true;
        }
      }

      const name = getDisplayName(type);
      if (name) {
        console.log('reporting render', fiber);
        reportRender(name, fiber, [propsRender, contextRender]);
      }

      if (!propsRender && !contextRender) return null;

      const allowList = ReactScanInternals.componentAllowList;
      const shouldAllow =
        allowList?.has(fiber.type) ?? allowList?.has(fiber.elementType);

      if (shouldAllow) {
        const parent = traverseFiber(
          fiber,
          (node) => {
            const options =
              allowList?.get(node.type) ?? allowList?.get(node.elementType);
            return options?.includeChildren;
          },
          true,
        );
        if (!parent && !shouldAllow) return null;
      }

      if (propsRender) {
        propsRender.trigger = trigger;
        onRender(fiber, propsRender);
      }
      if (contextRender) {
        contextRender.trigger = trigger;
        onRender(fiber, contextRender);
      }
    };

    const rootFiber = root.current;
    const wasMounted =
      rootFiber.alternate !== null &&
      Boolean(rootFiber.alternate.memoizedState?.element) &&
      // A dehydrated root is not considered mounted
      rootFiber.alternate.memoizedState.isDehydrated !== true;
    const isMounted = Boolean(rootFiber.memoizedState?.element);

    const mountFiber = (firstChild: Fiber, traverseSiblings: boolean) => {
      let fiber: Fiber | null = firstChild;

      // eslint-disable-next-line eqeqeq
      while (fiber != null) {
        const shouldIncludeInTree = !shouldFilterFiber(fiber);
        if (shouldIncludeInTree) {
          recordRender(fiber);
        }

        // eslint-disable-next-line eqeqeq
        if (fiber.child != null) {
          mountFiber(fiber.child, true);
        }
        fiber = traverseSiblings ? fiber.sibling : null;
      }
    };

    const updateFiber = (nextFiber: Fiber, prevFiber: Fiber) => {
      if (!prevFiber) return;

      const shouldIncludeInTree = !shouldFilterFiber(nextFiber);
      if (shouldIncludeInTree) {
        recordRender(nextFiber);
      }

      if (nextFiber.child !== prevFiber.child) {
        let nextChild = nextFiber.child;

        while (nextChild) {
          if (nextChild.alternate) {
            const prevChild = nextChild.alternate;

            updateFiber(nextChild, prevChild);
          } else {
            mountFiber(nextChild, false);
          }

          // Try the next child.
          nextChild = nextChild.sibling;
        }
      }
    };

    if (!wasMounted && isMounted) {
      mountFiber(rootFiber, false);
    } else if (wasMounted && isMounted) {
      updateFiber(rootFiber, rootFiber.alternate);
    }

    onCommitFinish();
  };

  ReactScanInternals.onCommitFiberRoot = (
    rendererID: number,
    root: FiberRoot,
  ) => {
    try {
      handleCommitFiberRoot(rendererID, root);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[React Scan] Error instrumenting: ', err);
    }
  };

  registerDevtoolsHook({
    onCommitFiberRoot: ReactScanInternals.onCommitFiberRoot,
  });
};
