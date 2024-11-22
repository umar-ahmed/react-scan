import { Fiber } from 'react-reconciler';
import { ReactScanInternals } from '../../index';
import { getDisplayName } from '../instrumentation/utils';
import { throttle } from './utils';
import { devInvariant, NEVER_RUN } from '../utils';
import {
  ClassComponentTag,
  FunctionComponentTag,
  isHostComponent,
} from '../instrumentation/fiber';
import { getRect } from './outline';

let propsCanvas: HTMLCanvasElement | null = null;
let propsCtx: CanvasRenderingContext2D | null = null;
let resizeObserver: ResizeObserver | null = null;
let dpr: number = window.devicePixelRatio || 1;

const setHoveredDomElement = throttle((el: HTMLElement | null) => {
  if (ReactScanInternals.hoveredDomElement !== el) {
    ReactScanInternals.hoveredDomElement = el;
    ReactScanInternals.emit('hoveredDomElement', el);
  }
}, 100);

const findNearestNonHostComponent = (fiber: Fiber): Fiber | null => {
  let current: Fiber | null = fiber;
  while (current) {
    if (!isHostComponent(current)) {
      return current;
    }
    current = current.return;
  }
  return null;
};

const getFiberFromElement = (element: HTMLElement): Fiber | null => {
  if ('__REACT_DEVTOOLS_GLOBAL_HOOK__' in window) {
    const { renderers } = window.__REACT_DEVTOOLS_GLOBAL_HOOK__!;
    if (!renderers) return null;
    for (const [_, renderer] of Array.from(renderers)) {
      try {
        const fiber = renderer.findFiberByHostInstance(element);
        if (fiber) return fiber;
      } catch (e) {
        // If React is mid-render, references to previous nodes may disappear
      }
    }
  }

  if ('_reactRootContainer' in element) {
    // @ts-expect-error - Property '_reactRootContainer' does not exist on type 'HTMLElement'
    return element._reactRootContainer?._internalRoot?.current?.child;
  }

  for (const key in element) {
    if (
      key.startsWith('__reactInternalInstance$') ||
      key.startsWith('__reactFiber')
    ) {
      return element[key as keyof HTMLElement] as unknown as Fiber;
    }
  }
  return null;
};

const getFirstStateNode = (fiber: Fiber): HTMLElement | null => {
  let current = fiber;
  while (current) {
    if (current.stateNode instanceof HTMLElement) {
      return current.stateNode;
    }
    if (current === current.child) {
      return null; // Protect against circular references
      // todo we dont need this im dumb
    }
    if (!current.child) {
      return null;
    }
    current = current.child;
  }
  return null;
};

const getNearestFiberFromElement = (element: HTMLElement | null) => {
  if (!element) return null;
  let target: HTMLElement | null = element;
  let originalFiber = getFiberFromElement(target);
  if (!originalFiber) {
    return null;
  }
  // we actually need the closest fiber that's not a composite

  const res = getParentCompositeComponent(originalFiber);
  if (!res) {
    return null;
  }

  return [res[0], null] as const; // im lazy one sec
  // console.log('ORIGINAL TAG', originalFiber.tag);
  // let count = 0;
  // // First try going up through parents

  // while (target) {
  //   // this is so silly but we do the count logic to not call getFiberFromElement a single extra time
  //   const fiberNode = count++ ? originalFiber : getFiberFromElement(target);
  //   // console.log('FIRST RETUR
  //   count += 1;
  //   if (fiberNode) {
  //     const nonHostFiber = findNearestNonHostComponent(fiberNode);
  //     if (nonHostFiber) return [originalFiber, originalFiber] as const;
  //   }
  //   target = target.parentElement;
  // }

  // // If no match found in parents, try children
  // const queue: HTMLElement[] = [element];
  // const visited = new Set<HTMLElement>();

  // while (queue.length > 0) {
  //   const current = queue.shift()!;
  //   if (visited.has(current)) continue;
  //   visited.add(current);

  //   const fiberNode = getFiberFromElement(current);
  //   if (fiberNode) {
  //     const nonHostFiber = findNearestNonHostComponent(fiberNode);
  //     if (nonHostFiber) return [nonHostFiber];
  //   }

  //   const children = Array.from(current.children) as HTMLElement[];
  //   queue.push(...children);
  // }

  // devInvariant(
  //   NEVER_RUN,
  //   'There should always be a non host component, remove this later this is not a fair assumption in all react apps',
  // );
  // return null;
};

const drawText = (
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: {
    color: string;
    alpha?: number;
  },
) => {
  ctx.fillStyle = style.color;
  ctx.globalAlpha = style.alpha ?? 1;
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
};

const COLORS = {
  componentName: '#59a6ff',
  label: '#9ca3af',
  text: '#e5e7eb',
  changed: '#d4a03c',
  muted: 'rgba(156, 163, 175, 0.6)',
  dot: '#9ca3af',
};

const measureSection = (
  ctx: CanvasRenderingContext2D,
  items: Array<[string, string]>,
  changed: string[],
) => {
  const itemHeight = 20;
  let maxWidth = 0;

  items.forEach(([key, value]) => {
    const text = `${key}: ${value}`;
    const textWidth = ctx.measureText(text).width;
    const changedWidth = changed.includes(key)
      ? ctx.measureText('● changed').width + 8
      : 0;
    maxWidth = Math.max(maxWidth, textWidth + changedWidth);
  });

  return {
    width: maxWidth + 32, // Padding
    height: items.length * itemHeight + 24,
  };
};

const drawChangedIndicator = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
) => {
  // Draw dot
  ctx.fillStyle = COLORS.changed;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(x, y + 6, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Draw "changed" text
  ctx.fillStyle = COLORS.changed;
  ctx.globalAlpha = 0.7;
  ctx.fillText(' changed', x + 4, y);
  ctx.globalAlpha = 1;
};

const drawSection = (
  ctx: CanvasRenderingContext2D,
  label: string,
  items: Array<[string, string]>,
  changed: string[],
  x: number,
  y: number,
) => {
  const lineHeight = 20;

  // Draw section label with dot
  ctx.fillStyle = COLORS.dot;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(x + 14, y + 6, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  drawText(ctx, label, x + 24, y, { color: COLORS.label });

  // Draw items
  let currentY = y + lineHeight + 4;
  items.forEach(([key, value]) => {
    const isChanged = changed.includes(key);
    const text = `${key}: ${value}`;

    drawText(ctx, text, x + 24, currentY, {
      color: COLORS.text,
      alpha: isChanged ? 1 : 0.6,
    });

    if (isChanged) {
      const textWidth = ctx.measureText(text).width;
      drawChangedIndicator(ctx, x + 32 + textWidth, currentY);
    }

    currentY += lineHeight;
  });

  return currentY;
};
// export const getRect = (domNode: HTMLElement): DOMRect | null => {
//   const now = performance.now();
//   const cached = rectCache.get(domNode);

//   if (cached && now - cached.timestamp < DEFAULT_THROTTLE_TIME) {
//     return cached.rect;
//   }

//   const style = window.getComputedStyle(domNode);
//   if (
//     style.display === 'none' ||
//     style.visibility === 'hidden' ||
//     style.opacity === '0'
//   ) {
//     return null;
//   }

//   const rect = domNode.getBoundingClientRect();

//   const isVisible =
//     rect.bottom > 0 &&
//     rect.right > 0 &&
//     rect.top < window.innerHeight &&
//     rect.left < window.innerWidth;

//   if (!isVisible || !rect.width || !rect.height) {
//     return null;
//   }

//   // Adjust for device pixel ratio
//   const dpr = window.devicePixelRatio || 1;

//   const adjustedRect = new DOMRect(
//     rect.left * dpr,
//     rect.top * dpr,
//     rect.width * dpr,
//     rect.height * dpr,
//   );

//   rectCache.set(domNode, { rect: adjustedRect, timestamp: now });

//   return adjustedRect;
// };

const drawPropsOverlay = (element: HTMLElement | null) => {
  if (!propsCtx || !propsCanvas) return;

  const res = getNearestFiberFromElement(element);
  if (!res) return;
  const [associatedFiber] = res;

  const anotherRes = getParentCompositeComponent(associatedFiber); // bruh
  if (!anotherRes) {
    return;
  }
  const [parentCompositeFiber] = anotherRes;

  const displayText = getDisplayName(parentCompositeFiber);

  const stateNode = getFirstStateNode(associatedFiber);
  if (!stateNode) return;

  const rect = getRect(stateNode);
  if (!rect) return;

  // Clear canvas
  propsCtx.save();
  propsCtx.setTransform(1, 0, 0, 1, 0, 0);
  propsCtx.clearRect(0, 0, propsCanvas.width, propsCanvas.height);
  propsCtx.restore();

  propsCtx.save();
  if (element) {
    drawHoverOverlay(element);
  }

  // Setup text style
  propsCtx.font = '12px "SF Mono", Monaco, monospace';
  propsCtx.textBaseline = 'top';

  const reportData =
    ReactScanInternals.reportData.get(parentCompositeFiber) ||
    (parentCompositeFiber.alternate
      ? ReactScanInternals.reportData.get(parentCompositeFiber.alternate)
      : null);
  console.log(
    'report data?',
    reportData,
    parentCompositeFiber,
    ReactScanInternals.reportData,
  );
  const componentInfo = {
    name: 'ThemeSwitcher',
    props: [
      ['theme', '"light"'] as [string, string],
      ['toggleTheme', 'ƒ()'] as [string, string],
    ],
    state: [
      ['isHovered', 'false'] as [string, string],
      ['timesClicked', '5'] as [string, string],
    ],
    changedProps: ['theme', 'toggleTheme'],
    changedState: ['timesClicked'],
    renderCount: reportData?.count ?? 0,
    renderTime: reportData?.time.toFixed(2) ?? 0,
  };

  const propsSection = measureSection(
    propsCtx,
    componentInfo.props,
    componentInfo.changedProps,
  );
  const stateSection = measureSection(
    propsCtx,
    componentInfo.state,
    componentInfo.changedState,
  );
  const headerHeight = 36;
  const footerHeight = 32;

  const boxWidth = Math.max(
    propsCtx.measureText(componentInfo.name).width + 48,
    propsSection.width,
    stateSection.width,
  );
  const boxHeight =
    headerHeight + propsSection.height + stateSection.height + footerHeight;

  // Position overlay
  let x = rect.right + 8;
  let y = Math.max(8, rect.top);

  if (x + boxWidth > propsCanvas.width / dpr) {
    x = rect.left - boxWidth - 8;
  }

  if (y + boxHeight > propsCanvas.height / dpr) {
    y = Math.max(8, propsCanvas.height / dpr - boxHeight - 8);
  }

  //  background
  propsCtx.fillStyle = 'rgba(23, 23, 23, 0.95)';
  propsCtx.beginPath();
  propsCtx.roundRect(x, y, boxWidth, boxHeight, 6);
  propsCtx.fill();

  //  component name
  drawText(propsCtx, displayText ?? 'Unknown', x + 24, y + 12, {
    color: COLORS.componentName,
  });

  //  sections
  let currentY = y + headerHeight;
  currentY = drawSection(
    propsCtx,
    'props',
    componentInfo.props,
    componentInfo.changedProps,
    x,
    currentY,
  );
  currentY = drawSection(
    propsCtx,
    'state',
    componentInfo.state,
    componentInfo.changedState,
    x,
    currentY,
  );

  //  render stats
  propsCtx.fillStyle = COLORS.muted;
  const statsY = y + boxHeight - 24;
  propsCtx.fillText(
    `⟳ ${componentInfo.renderCount}×  •  ⏱ ${componentInfo.renderTime}ms`,
    x + 24,
    statsY,
  );

  propsCtx.restore();
};

const getParentCompositeFiber = (fiber: Fiber) => {
  let curr: Fiber | null = fiber;

  while (curr) {
    if (curr.tag === FunctionComponentTag || curr.tag === ClassComponentTag) {
      return curr;
    }
    curr = curr.return;
  }
  return fiber;
};
// remove this
export const listenForClick = () => {
  if (typeof window === 'undefined') return;

  document.addEventListener('click', (e) => {
    // // const fiberNode = getFiberFromElement(target); // todo: dedup
    // const res = getNearestFiberFromElement(e.target as HTMLElement); // handles getting the correct bounding box (a host component does not have a )
    // if (!res) {
    //   return;
    // }
    // const [nearestFiber, original] = res;
    // const parentCompositeFiber = getParentCompositeFiber(original);
    // // shouldn't need this
    // if (!nearestFiber) return;
    // console.log(
    //   'is nearest a composite?',
    //   nearestFiber.tag === FunctionComponentTag,
    //   nearestFiber.tag === ClassComponentTag,
    //   nearestFiber.tag,
    // );
    // // const parentCompositeFiber = getParentCompositeComponent(nearestFiber);
    // //
    // const stateNode = getFirstStateNode(nearestFiber);
    // if (!stateNode) return;
    // const rect = getRect(stateNode);
    // if (!rect) return;
    // ReactScanInternals.activePropOverlays.length = 0;
    // ReactScanInternals.activePropOverlays.push({
    //   displayName: getDisplayName(parentCompositeFiber.type) ?? 'Unknown',
    //   props: nearestFiber.memoizedProps,
    //   rect,
    // });
    // ReactScanInternals.emit(
    //   'activePropOverlays',
    //   ReactScanInternals.activePropOverlays,
    // );
  });
};

export const listenForMouseMove = () => {
  document.addEventListener('mousemove', (e) => {
    setHoveredDomElement(e.target as HTMLElement);
  });
};

export const initPropsOverlay = (mainCanvas: HTMLCanvasElement) => {
  if (propsCanvas) return;

  propsCanvas = document.createElement('canvas');
  propsCanvas.style.position = 'fixed';
  propsCanvas.style.left = '0';
  propsCanvas.style.top = '0';
  propsCanvas.style.width = '100vw';
  propsCanvas.style.height = '100vh';
  propsCanvas.style.pointerEvents = 'none';
  propsCanvas.style.zIndex = '9999';

  propsCtx = propsCanvas.getContext('2d', { alpha: true });

  const updateCanvasSize = () => {
    if (!propsCanvas) return;
    const dpr = window.devicePixelRatio || 1;

    propsCanvas.width = Math.floor(window.innerWidth * dpr);
    propsCanvas.height = Math.floor(window.innerHeight * dpr);

    if (propsCtx) {
      propsCtx.setTransform(1, 0, 0, 1, 0, 0); // reset
      propsCtx.scale(dpr, dpr); // dpi
    }
  };

  updateCanvasSize();

  window.addEventListener('resize', () => {
    updateCanvasSize();
    if (ReactScanInternals.hoveredDomElement) {
      drawPropsOverlay(ReactScanInternals.hoveredDomElement);
    }
  });

  window.addEventListener('scroll', () => {
    if (ReactScanInternals.hoveredDomElement) {
      drawPropsOverlay(ReactScanInternals.hoveredDomElement);
    }
  });

  document.documentElement.appendChild(propsCanvas);

  const unsubOverlays = ReactScanInternals.subscribe(
    'activePropOverlays',
    (overlays) => {
      if (propsCtx && propsCanvas) {
        drawPropsOverlay(ReactScanInternals.hoveredDomElement);
      }
    },
  );
  const onReportRender = throttle(() => {
    if (propsCtx && propsCanvas) {
      drawPropsOverlay(ReactScanInternals.hoveredDomElement);
    }
  }, 0); // this does not need to update frequently, maybe can go even lower, its just for the prop overlay
  // todo: why is first update getting missed when throttle > 0
  const unsubReportData = ReactScanInternals.subscribe(
    'reportData',
    onReportRender,
  );

  const unsubHover = ReactScanInternals.subscribe(
    'hoveredDomElement',
    (element) => {
      if (propsCtx && propsCanvas) {
        drawPropsOverlay(element);
      }
    },
  );

  propsCanvas.cleanup = () => {
    window.removeEventListener('resize', updateCanvasSize);
    window.removeEventListener('scroll', drawPropsOverlay);
    unsubOverlays();
    unsubHover();
    propsCanvas?.remove();
    propsCanvas = null;
    propsCtx = null;
  };
};

export const cleanupPropsOverlay = () => {
  propsCanvas?.cleanup?.();
};

// Types
interface ActiveProp {
  rect: DOMRect;
  displayName: string;
  props: Record<string, unknown>;
}

declare global {
  interface HTMLCanvasElement {
    cleanup?: () => void;
  }

  interface Window {
    ReactScanInternals: {
      subscribe: (key: string, listener: (value: any) => void) => () => void;
      emit: (key: string, value: any) => void;
      hoveredDomElement: HTMLElement | null;
      activePropOverlays: Array<ActiveProp>;
    };
  }
}
const getParentCompositeComponent = (fiber: Fiber) => {
  let curr: Fiber | null = fiber;
  let prevNonHost = null;

  while (curr) {
    if (curr.tag === FunctionComponentTag || curr.tag === ClassComponentTag) {
      // we may want to just check !hostComponent, not sure yet hold on
      return [curr, prevNonHost] as const;
    }
    if (isHostComponent(curr)) {
      prevNonHost = curr;
    }
    curr = curr.return; // search up to find the component that rendered the host component
  }
};

// -----------------------------------------------

const formatPropValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'ƒ()';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `Array(${value.length})`;
    if (value instanceof Date) return value.toISOString();
    return '{…}';
  }
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
};
const drawHoverOverlay = (element: HTMLElement) => {
  if (!propsCtx || !propsCanvas) return;

  const res = getNearestFiberFromElement(element);
  if (!res) return;
  const [associatedFiber] = res;

  const stateNode = getFirstStateNode(associatedFiber);
  if (!stateNode) return;

  const rect = getRect(stateNode);
  if (!rect) return;

  const THEME = {
    bg: 'rgba(23, 23, 23, 0.9)',
    border: 'rgba(255, 255, 255, 0.08)',
    component: 'rgb(130, 170, 255)',
    text: 'rgba(255, 255, 255, 0.9)',
    mutedText: 'rgba(255, 255, 255, 0.5)',
    highlight: 'rgba(130, 170, 255, 0.1)',
    highlightBorder: 'rgba(130, 170, 255, 0.6)',
  };

  // Clear canvas
  propsCtx.save();
  propsCtx.setTransform(1, 0, 0, 1, 0, 0);
  propsCtx.clearRect(0, 0, propsCanvas.width, propsCanvas.height);
  propsCtx.restore();

  propsCtx.save();

  // Draw element highlight
  propsCtx.strokeStyle = THEME.highlightBorder;
  propsCtx.fillStyle = THEME.highlight;
  propsCtx.lineWidth = 1;
  propsCtx.fillRect(rect.left, rect.top, rect.width, rect.height);
  propsCtx.strokeRect(rect.left, rect.top, rect.width, rect.height);

  // // Mock data
  // const mockRenderData = {
  //   changedProps: ['theme', 'toggleTheme'],
  //   lastRenderTime: 12,
  //   renderCount: 3,
  // };

  // // Setup text styling
  // propsCtx.font = '12px Menlo, monospace';
  // const lineHeight = 21;
  // const padding = 12;

  // // Format and measure all text content
  // const displayName = getDisplayName(nearestFiber.type) ?? 'Unknown';
  // const props = nearestFiber.memoizedProps;

  // // Create and measure all content upfront
  // const componentLine = {
  //   text: `<${displayName}>`,
  //   width: propsCtx.measureText(`<${displayName}>`).width,
  // };

  // const propLines = Object.entries(props || {})
  //   .filter(([key]) => key !== 'children')
  //   .map(([key, value]) => {
  //     const text = `  ${key}: ${formatPropValue(value)}`;
  //     return {
  //       text,
  //       width:
  //         propsCtx.measureText(text).width +
  //         (mockRenderData.changedProps.includes(key) ? 25 : 0), // Add space for 🔥
  //       changed: mockRenderData.changedProps.includes(key),
  //     };
  //   });

  // const statsLine = {
  //   text: `${mockRenderData.renderCount}× renders • ${mockRenderData.lastRenderTime}ms`,
  //   width: propsCtx.measureText(
  //     `${mockRenderData.renderCount}× renders • ${mockRenderData.lastRenderTime}ms`,
  //   ).width,
  // };

  // // Calculate exact content width
  // const contentWidth = Math.max(
  //   componentLine.width,
  //   ...propLines.map((line) => line.width),
  //   statsLine.width,
  // );

  // // Calculate exact box dimensions
  // const boxWidth = contentWidth + padding * 2;
  // const boxHeight =
  //   lineHeight * (propLines.length + 1) + // Component line + prop lines
  //   padding * 2 + // Top and bottom padding
  //   1 + // Separator
  //   lineHeight; // Stats line

  // // Position overlay
  // let x = rect.right + 8;
  // let y = Math.max(8, rect.top);

  // if (x + boxWidth > propsCanvas.width / dpr) {
  //   x = rect.left - boxWidth - 8;
  // }

  // if (y + boxHeight > propsCanvas.height / dpr) {
  //   y = Math.max(8, propsCanvas.height / dpr - boxHeight - 8);
  // }

  // // Draw overlay background
  // propsCtx.fillStyle = THEME.bg;
  // propsCtx.beginPath();
  // propsCtx.roundRect(x, y, boxWidth, boxHeight, 6);
  // propsCtx.fill();

  // // Draw border
  // propsCtx.strokeStyle = THEME.border;
  // propsCtx.lineWidth = 1;
  // propsCtx.stroke();

  // // Draw component name
  // let currentY = y + padding + 4;
  // propsCtx.fillStyle = THEME.component;
  // propsCtx.fillText(componentLine.text, x + padding, currentY);
  // currentY += lineHeight;

  // // Draw props
  // propLines.forEach((line) => {
  //   propsCtx.fillStyle = line.changed ? THEME.text : THEME.mutedText;
  //   propsCtx.fillText(line.text, x + padding, currentY);

  //   if (line.changed) {
  //     propsCtx.fillText('🔥', x + padding + line.width - 20, currentY);
  //   }

  //   currentY += lineHeight;
  // });

  // // Draw separator
  // currentY -= lineHeight / 2;
  // propsCtx.strokeStyle = THEME.border;
  // propsCtx.beginPath();
  // propsCtx.moveTo(x + padding, currentY);
  // propsCtx.lineTo(x + boxWidth - padding, currentY);
  // propsCtx.stroke();

  // // Draw stats
  // currentY += lineHeight / 2;
  // propsCtx.fillStyle = THEME.mutedText;
  // propsCtx.fillText(statsLine.text, x + padding, currentY);

  propsCtx.restore();
};
