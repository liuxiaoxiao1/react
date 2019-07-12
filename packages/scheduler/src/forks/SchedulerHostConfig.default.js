/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The DOM Scheduler implementation is similar to requestIdleCallback. It
// works by scheduling a requestAnimationFrame, storing the time for the start
// of the frame, then scheduling a postMessage which gets scheduled after paint.
// Within the postMessage handler do as much work as possible until time + frame
// rate. By separating the idle call into a separate event tick we ensure that
// layout, paint and other browser work is counted against the available time.
// The frame rate is dynamically adjusted.

export let requestHostCallback;
export let cancelHostCallback;
export let shouldYieldToHost;
export let getCurrentTime;
export let forceFrameRate;

const hasNativePerformanceNow =
  typeof performance === 'object' && typeof performance.now === 'function';

// We capture a local reference to any global, in case it gets polyfilled after
// this module is initially evaluated. We want to be using a
// consistent implementation.
const localDate = Date;

// This initialization code may run even on server environments if a component
// just imports ReactDOM (e.g. for findDOMNode). Some environments might not
// have setTimeout or clearTimeout. However, we always expect them to be defined
// on the client. https://github.com/facebook/react/pull/13088
const localSetTimeout =
  typeof setTimeout === 'function' ? setTimeout : undefined;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : undefined;

// We don't expect either of these to necessarily be defined, but we will error
// later if they are missing on the client.
const localRequestAnimationFrame =
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : undefined;
const localCancelAnimationFrame =
  typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined;

// requestAnimationFrame does not run when the tab is in the background. If
// we're backgrounded we prefer for that work to happen so that the page
// continues to load in the background. So we also schedule a 'setTimeout' as
// a fallback.
// 启发式的任务
// TODO: Need a better heuristic for backgrounded work.
const ANIMATION_FRAME_TIMEOUT = 100;
let rAFID;
let rAFTimeoutID;
// localRequestAnimationFrame 与 setTimeout 是竞争关系，谁先满足条件谁先执行，一旦一个执行就取消另外一个。
const requestAnimationFrameWithTimeout = function(callback) {
  // schedule rAF and also a setTimeout
  // timestamp 等同于 performance.now() ，是requestAnimationFrame 的回调   // 文档加载到当前的时间
  rAFID = localRequestAnimationFrame(function(timestamp) {
    // cancel the setTimeout
    localClearTimeout(rAFTimeoutID);
    callback(timestamp);
  });
  // 必须在 100 ms 内调用，否则等待时间太长： 先取消掉 localCancelAnimationFrame，然后直接调用
  rAFTimeoutID = localSetTimeout(function() {
    // cancel the requestAnimationFrame
    localCancelAnimationFrame(rAFID);
    callback(getCurrentTime());
  }, ANIMATION_FRAME_TIMEOUT);
};

if (hasNativePerformanceNow) {
  const Performance = performance;
  getCurrentTime = function() {
    return Performance.now();
  };
} else {
  getCurrentTime = function() {
    return localDate.now();
  };
}

if (
  // If Scheduler runs in a non-DOM environment, it falls back to a naive
  // implementation using setTimeout.
  typeof window === 'undefined' ||
  // Check if MessageChannel is supported, too.
  typeof MessageChannel !== 'function'
) {
  // If this accidentally gets imported in a non-browser environment, e.g. JavaScriptCore,
  // fallback to a naive implementation.
  let _callback = null;
  const _flushCallback = function(didTimeout) {
    if (_callback !== null) {
      try {
        _callback(didTimeout);
      } finally {
        _callback = null;
      }
    }
  };
  requestHostCallback = function(cb, ms) {
    if (_callback !== null) {
      // Protect against re-entrancy.
      setTimeout(requestHostCallback, 0, cb);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, 0, false);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  shouldYieldToHost = function() {
    return false;
  };
  forceFrameRate = function() {};
} else {
  if (typeof console !== 'undefined') {
    // TODO: Remove fb.me link
    if (typeof localRequestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof localCancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  let scheduledHostCallback = null;
  let isMessageEventScheduled = false;
  let timeoutTime = -1;

  let isAnimationFrameScheduled = false;

  let isFlushingHostCallback = false;

  let frameDeadline = 0;
  // We start out assuming that we run at 30fps but then the heuristic tracking  // 启发式的追踪，后续会根据实际情况更新
  // will adjust this value to a faster fps if we get more frequent animation
  // frames.
  // 确保 30 帧
  // 每一帧的时间
  let previousFrameTime = 33;
  let activeFrameTime = 33;
  let fpsLocked = false;

  shouldYieldToHost = function() {
    return frameDeadline <= getCurrentTime();
  };

  forceFrameRate = function(fps) {
    if (fps < 0 || fps > 125) {
      console.error(
        'forceFrameRate takes a positive int between 0 and 125, ' +
          'forcing framerates higher than 125 fps is not unsupported',
      );
      return;
    }
    if (fps > 0) {
      activeFrameTime = Math.floor(1000 / fps);
      fpsLocked = true;
    } else {
      // reset the framerate
      activeFrameTime = 33;
      fpsLocked = false;
    }
  };

  // We use the postMessage trick to defer idle work until after the repaint.
  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = function(event) {
    isMessageEventScheduled = false;

    const prevScheduledCallback = scheduledHostCallback;
    const prevTimeoutTime = timeoutTime;
    scheduledHostCallback = null;
    timeoutTime = -1;

    const currentTime = getCurrentTime();

    let didTimeout = false;
    if (frameDeadline - currentTime <= 0) {
      // There's no time left in this idle period. Check if the callback has
      // a timeout and whether it's been exceeded.
      if (prevTimeoutTime !== -1 && prevTimeoutTime <= currentTime) {
        // Exceeded the timeout. Invoke the callback even though there's no
        // time left.
        didTimeout = true;
      } else {
        // No timeout.
        if (!isAnimationFrameScheduled) {
          // Schedule another animation callback so we retry later.
          isAnimationFrameScheduled = true;
          requestAnimationFrameWithTimeout(animationTick);
        }
        // Exit without invoking the callback.
        scheduledHostCallback = prevScheduledCallback;
        timeoutTime = prevTimeoutTime;
        return;
      }
    }

    if (prevScheduledCallback !== null) {
      isFlushingHostCallback = true;
      try {
        prevScheduledCallback(didTimeout);
      } finally {
        isFlushingHostCallback = false;
      }
    }
  };

  const animationTick = function(rafTime) {
    // 在上一步设置过了，所以这里不会为 null
    if (scheduledHostCallback !== null) {
      // Eagerly schedule the next animation callback at the beginning of the
      // frame. If the scheduler queue is not empty at the end of the frame, it
      // will continue flushing inside that callback. If the queue *is* empty,
      // then it will exit immediately. Posting the callback at the start of the
      // frame ensures it's fired within the earliest possible frame. If we
      // waited until the end of the frame to post the callback, we risk the
      // browser skipping a frame and not firing the callback until the frame
      // after that.
      // 尽早的在帧的开头执行 下一个回调，节省掉不必要的等待时间，如果一下个为 null，退出即可
      // TODO: why，下面直接执行不是更早么，难道是下一帧里的最早时间: 一帧里只执行一个 callBack，
      requestAnimationFrameWithTimeout(animationTick);
    } else {
      // No pending work. Exit.
      // 没有要调度的方法
      isAnimationFrameScheduled = false;
      return;
    }


    //  = 调用的时间 - 0 + 33
    // 当前到下一帧结束前，可以执行 JS 的截止时间
    // frameDeadline 会更新为 上一帧的结束时间
    let nextFrameTime = rafTime - frameDeadline + activeFrameTime;
    // 如果 nextFrameTime == activeFrameTime： 说明 activeFrameTime 刚刚好与实际设备相符合
    // 如果 nextFrameTime < activeFrameTime，说明 rafTime < frameDeadline；说明下一帧到的比预期早，说明实际设备的帧率比当前设置的要高
    // previousFrameTime < activeFrameTime: 说明 上一帧刷新也比目前优化的帧率高： 确保连续两帧都比目前设定的值小
    // 到最后优化的结果是 nextFrameTime 很接近 activeFrameTime
    if (
      nextFrameTime < activeFrameTime &&
      previousFrameTime < activeFrameTime &&
      !fpsLocked
    ) {
      // 最高支持到 120 帧
      if (nextFrameTime < 8) {
        // Defensive coding. We don't support higher frame rates than 120hz.
        // If the calculated frame time gets lower than 8, it is probably a bug.
        nextFrameTime = 8;
      }
      // If one frame goes long, then the next one can be short to catch up.
      // If two frames are short in a row, then that's an indication that we
      // actually have a higher frame rate than what we're currently optimizing.
      // We adjust our heuristic dynamically accordingly. For example, if we're
      // running on 120hz display or 90hz VR display.
      // Take the max of the two in case one of them was an anomaly due to
      // missed frame deadlines.
      // 最新帧时间 < 上一帧 时间 ? 上一帧时间 ： 最新帧时间  最后取了个大的。 等待趋于稳定的帧率？
      activeFrameTime =
        nextFrameTime < previousFrameTime ? previousFrameTime : nextFrameTime;
    } else {
      previousFrameTime = nextFrameTime;
    }
    frameDeadline = rafTime + activeFrameTime;
    if (!isMessageEventScheduled) {
      isMessageEventScheduled = true;
      port.postMessage(undefined);
    }
  };

  requestHostCallback = function(callback, absoluteTimeout) {
    scheduledHostCallback = callback;
    timeoutTime = absoluteTimeout;
    // 这两种情况下 就立即执行：
    if (isFlushingHostCallback || absoluteTimeout < 0) {
      // Don't wait for the next frame. Continue working ASAP, in a new event.
      port.postMessage(undefined);
    } else if (!isAnimationFrameScheduled) {
      // If rAF didn't already schedule one, we need to schedule a frame.
      // TODO: If this rAF doesn't materialize because the browser throttles, we
      // might want to still have setTimeout trigger rIC as a backup to ensure
      // that we keep performing work.
      isAnimationFrameScheduled = true;
      requestAnimationFrameWithTimeout(animationTick);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
    isMessageEventScheduled = false;
    timeoutTime = -1;
  };
}
