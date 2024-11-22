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
  traverseContexts,
  traverseFiber,
} from './fiber';

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
    if (ReactScanInternals.isPaused) return;
    onCommitStart();

    const handleFiber = (fiber: Fiber, trigger: boolean) => {
      const type = getType(fiber.type);
      if (!type) return null;
      if (!didFiberRender(fiber)) return null;
      const propsRender = getPropsRender(fiber, type);
      const contextRender = getContextRender(fiber, type);
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

    if (root.memoizedUpdaters) {
      for (const fiber of root.memoizedUpdaters) {
        handleFiber(fiber, true);
      }
    }

    traverseFiber(root.current, (fiber) => {
      handleFiber(fiber, false);
    });

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
