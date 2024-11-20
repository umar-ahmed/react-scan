import { type Fiber } from 'react-reconciler';
import { getNearestHostFiber } from '../instrumentation/fiber';
import type { Render } from '../instrumentation/index';
import { Measurement, ReactScanInternals } from '../index';
import { getLabelText } from '../utils';
import { isOutlineUnstable, onIdle, throttle } from './utils';
import { log } from './log';
import { recalcOutlineColor } from './perf-observer';
import { genId } from '../native';

export const assertDom = (measurement: Measurement) => {
  if (measurement.kind !== 'dom') {
    throw new Error('dom invariant');
  }
  return measurement;
};

export interface PendingOutline {
  fiber: WeakRef<Fiber>;
  cachedMeasurement: Measurement;
  renders: Render[];
}

export interface ActiveOutline {
  outline: PendingOutline;
  id: string;
  alpha: number;
  frame: number;
  totalFrames: number;
  resolve: () => void;
  text: string | null;
  color: { r: number; g: number; b: number };
  updatedAt: number;
}

export interface PaintedOutline {
  alpha: number;
  outline: PendingOutline;
  text: string | null;
}

export function devInvariant<T>(
  value: T | null | undefined,
  message: string,
  prodMessage?: string,
): asserts value is T {
  if (value) {
    return;
  }
  if (!ReactScanInternals.isProd) {
    throw new Error(message);
  }

  if (prodMessage) {
    console.error(message);
  }
}

export const MONO_FONT =
  'Menlo,Consolas,Monaco,Liberation Mono,Lucida Console,monospace';
const DEFAULT_THROTTLE_TIME = 16; // 1 frame
export const colorRef = { current: '115,97,230' };

export const getOutlineKey = (rect: DOMRect): string => {
  return `${rect.top}-${rect.left}-${rect.width}-${rect.height}`;
};

const rectCache = new Map<HTMLElement, { rect: DOMRect; timestamp: number }>();

export const getRect = (domNode: HTMLElement): DOMRect | null => {
  const cached = rectCache.get(domNode);
  if (cached && cached.timestamp > performance.now() - DEFAULT_THROTTLE_TIME) {
    return cached.rect;
  }

  const style = window.getComputedStyle(domNode);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  ) {
    return null;
  }

  const rect = domNode.getBoundingClientRect();

  const isVisible =
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth;

  if (!isVisible || !rect.width || !rect.height) {
    return null;
  }

  rectCache.set(domNode, { rect, timestamp: performance.now() });

  return rect;
};

export const getOutline = (
  fiber: Fiber,
  render: Render,
): PendingOutline | null => {
  const domFiber = getNearestHostFiber(fiber);
  if (!domFiber) return null;

  const domNode = domFiber.stateNode;

  if (!(domNode instanceof HTMLElement)) return null;

  let shouldIgnore = false;

  let currentDomNode: HTMLElement | null = domNode;
  while (currentDomNode) {
    if (currentDomNode.hasAttribute('data-react-scan-ignore')) {
      shouldIgnore = true;
      break;
    }
    currentDomNode = currentDomNode.parentElement;
  }

  if (shouldIgnore) return null;

  const rect = getRect(domNode);
  if (!rect) return null;

  return {
    fiber: new WeakRef(fiber),
    renders: [render],
    cachedMeasurement: {
      kind: 'dom',
      value: rect,
    },
  };
};

export const mergeOutlines = (outlines: PendingOutline[]) => {
  const mergedOutlines = new Map<string, PendingOutline>();
  for (let i = 0, len = outlines.length; i < len; i++) {
    const outline = outlines[i];
    const key = getOutlineKey(assertDom(outline.cachedMeasurement).value);
    const existingOutline = mergedOutlines.get(key);

    if (!existingOutline) {
      mergedOutlines.set(key, outline);
      continue;
    }
    existingOutline.renders.push(...outline.renders);
  }
  return Array.from(mergedOutlines.values());
};

export const getDomNode = (outline: PendingOutline) => {
  const fiber = outline.fiber.deref();
  if (!fiber) {
    return;
  }
  const domNode = fiber.stateNode;
  if (!(domNode instanceof HTMLElement)) return null;
  return domNode;
};
export const recalcOutlines = throttle(() => {
  const { scheduledOutlines, activeOutlines } = ReactScanInternals;

  for (let i = scheduledOutlines.length - 1; i >= 0; i--) {
    const outline = scheduledOutlines[i];
    const domNode = getDomNode(outline);
    if (!domNode) continue;
    const rect = getRect(domNode);
    if (!rect) {
      scheduledOutlines.splice(i, 1);
      continue;
    }
    outline.cachedMeasurement.value = rect;
  }

  for (let i = activeOutlines.length - 1; i >= 0; i--) {
    const activeOutline = activeOutlines[i];
    if (!activeOutline) continue;
    const { outline } = activeOutline;
    const domNode = getDomNode(outline);
    if (!domNode) continue;
    const rect = getRect(domNode);
    if (!rect) {
      activeOutlines.splice(i, 1);
      continue;
    }
    outline.cachedMeasurement.value = rect;
  }
}, DEFAULT_THROTTLE_TIME);

export const flushOutlines = (
  ctx: CanvasRenderingContext2D,
  previousOutlines: Map<string, PendingOutline> = new Map(),
  toolbar: HTMLElement | null = null,
  perfObserver: PerformanceObserver | null = null,
) => {
  if (!ReactScanInternals.scheduledOutlines.length) {
    return;
  }

  const firstOutlines = ReactScanInternals.scheduledOutlines;
  ReactScanInternals.scheduledOutlines = [];

  requestAnimationFrame(() => {
    if (perfObserver) {
      recalcOutlineColor(perfObserver.takeRecords());
    }
    recalcOutlines();
    void (async () => {
      const secondOutlines = ReactScanInternals.scheduledOutlines;
      ReactScanInternals.scheduledOutlines = [];
      const mergedOutlines = secondOutlines
        ? mergeOutlines([...firstOutlines, ...secondOutlines])
        : firstOutlines;

      const newPreviousOutlines = new Map<string, PendingOutline>();

      if (toolbar) {
        let totalCount = 0;
        let totalTime = 0;

        for (let i = 0, len = mergedOutlines.length; i < len; i++) {
          const outline = mergedOutlines[i];
          for (let j = 0, len = outline.renders.length; j < len; j++) {
            const render = outline.renders[j];
            totalTime += render.time;
            totalCount += render.count;
          }
        }

        let text = `×${totalCount}`;
        if (totalTime > 0) text += ` (${totalTime.toFixed(2)}ms)`;
        toolbar.textContent = `${text} · react-scan`;
      }

      await Promise.all(
        mergedOutlines.map(async (outline) => {
          const key = getOutlineKey(assertDom(outline.cachedMeasurement).value);
          if (previousOutlines.has(key)) {
            return;
          }
          await paintOutline(ctx, outline);
          newPreviousOutlines.set(key, outline);
        }),
      );
      if (ReactScanInternals.scheduledOutlines.length) {
        flushOutlines(ctx, newPreviousOutlines, toolbar, perfObserver);
      }
    })();
  });
};

let animationFrameId: number | null = null;

export const paintOutline = (
  ctx: CanvasRenderingContext2D,
  outline: PendingOutline,
) => {
  return new Promise<void>((resolve) => {
    const unstable = isOutlineUnstable(outline);
    const totalFrames = unstable ? 60 : 5;
    const alpha = 0.8;

    const { options } = ReactScanInternals;
    options.onPaintStart?.(outline);
    if (options.log) {
      log(outline.renders);
    }

    const key = getOutlineKey(assertDom(outline.cachedMeasurement).value); // todo: fix for dom
    const existingActiveOutline = ReactScanInternals.activeOutlines.find(
      (activeOutline) =>
        getOutlineKey(
          assertDom(activeOutline.outline.cachedMeasurement).value,
        ) === key,
    );

    const renderCount = outline.renders.length;
    const maxRenders = ReactScanInternals.options.maxRenders;
    const t = Math.min(renderCount / (maxRenders ?? 20), 1);

    const startColor = { r: 115, g: 97, b: 230 };
    const endColor = { r: 185, g: 49, b: 115 };

    const r = Math.round(startColor.r + t * (endColor.r - startColor.r));
    const g = Math.round(startColor.g + t * (endColor.g - startColor.g));
    const b = Math.round(startColor.b + t * (endColor.b - startColor.b));

    const color = { r, g, b };

    if (existingActiveOutline) {
      existingActiveOutline.outline.renders.push(...outline.renders);
      existingActiveOutline.outline.cachedMeasurement =
        outline.cachedMeasurement;
      existingActiveOutline.frame = 0;
      existingActiveOutline.totalFrames = totalFrames;
      existingActiveOutline.alpha = alpha;
      existingActiveOutline.text = getLabelText(
        existingActiveOutline.outline.renders,
        'dom',
      );
      existingActiveOutline.color = color;
    } else {
      const frame = 0;
      ReactScanInternals.activeOutlines.push({
        outline,
        alpha,
        frame,
        totalFrames,
        resolve: () => {
          resolve();
          options.onPaintFinish?.(outline);
        },
        text: getLabelText(outline.renders, 'dom'),
        color,
        updatedAt: Date.now(),
        id: genId(),
      });
    }

    if (!animationFrameId) {
      animationFrameId = requestAnimationFrame(() => fadeOutOutline(ctx));
    }
  });
};

export const fadeOutOutline = (ctx: CanvasRenderingContext2D) => {
  const { activeOutlines } = ReactScanInternals;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const combinedPath = new Path2D();

  let maxStrokeAlpha = 0;
  let maxFillAlpha = 0;

  const pendingLabeledOutlines: PaintedOutline[] = [];

  for (let i = activeOutlines.length - 1; i >= 0; i--) {
    const activeOutline = activeOutlines[i];
    if (!activeOutline) continue;
    const { outline, frame, totalFrames } = activeOutline;
    requestAnimationFrame(() => {
      const domNode = getDomNode(outline);
      if (!domNode) {
        return;
      }
      const newRect = getRect(domNode);
      if (newRect) {
        outline.cachedMeasurement.value = newRect;
      }
    });
    const { value: rect } = assertDom(outline.cachedMeasurement);
    const unstable = isOutlineUnstable(outline);

    const alphaScalar = unstable ? 0.8 : 0.2;

    activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);

    maxStrokeAlpha = Math.max(maxStrokeAlpha, activeOutline.alpha);
    maxFillAlpha = Math.max(maxFillAlpha, activeOutline.alpha * 0.1);

    combinedPath.rect(rect.x, rect.y, rect.width, rect.height);

    if (unstable) {
      pendingLabeledOutlines.push({
        alpha: activeOutline.alpha,
        outline,
        text: activeOutline.text,
      });
    }

    activeOutline.frame++;

    if (activeOutline.frame > activeOutline.totalFrames) {
      activeOutlines.splice(i, 1);
    }
  }

  ctx.save();

  ctx.strokeStyle = `rgba(${colorRef.current}, ${maxStrokeAlpha})`;
  ctx.lineWidth = 1;
  ctx.fillStyle = `rgba(${colorRef.current}, ${maxFillAlpha})`;

  ctx.stroke(combinedPath);
  ctx.fill(combinedPath);

  ctx.restore();

  for (let i = 0, len = pendingLabeledOutlines.length; i < len; i++) {
    const { alpha, outline, text } = pendingLabeledOutlines[i];
    const { value: rect } = assertDom(outline.cachedMeasurement); // todo: fix for dom
    ctx.save();

    if (text) {
      ctx.font = `10px ${MONO_FONT}`;
      const textMetrics = ctx.measureText(text);
      const textWidth = textMetrics.width;
      const textHeight = 10;

      const labelX: number = rect.x;
      const labelY: number = rect.y - textHeight - 4;

      ctx.fillStyle = `rgba(${colorRef.current},${alpha})`;
      ctx.fillRect(labelX, labelY, textWidth + 4, textHeight + 4);

      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillText(text, labelX + 2, labelY + textHeight);
    }

    ctx.restore();
  }

  if (activeOutlines.length) {
    animationFrameId = requestAnimationFrame(() => fadeOutOutline(ctx));
  } else {
    animationFrameId = null;
  }
};
