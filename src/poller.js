'use strict';
// Runs a poll again and again: never two at once, four times slower while the window is not focused, and backing off
// when Jira throttles (429/503) or the network is down: the longer of Retry-After and a backoff of 5 s doubling to 5 min (design 101, "Polling and mentions").
const UNFOCUSED_FACTOR = 4;
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 300000;
const THROTTLE_NOTE = 'Jira is throttling, retrying';

const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

function createPoller({ run, everyMs, isFocused, onThrottle = () => {}, onError = () => {}, timers = realTimers }) {
  let timer = null, running = false, stopped = true, backoff = 0, throttled = false;

  function schedule(ms) { if (!stopped) timer = timers.set(tick, ms); }

  async function tick() {
    timer = null;
    if (running || stopped) return;
    running = true;
    let wait = everyMs * (isFocused() ? 1 : UNFOCUSED_FACTOR);
    try {
      await run();
      backoff = 0;
      if (throttled) { throttled = false; onThrottle(null); }
    } catch (e) {
      const throttle = e && (e.status === 429 || e.status === 503);
      if (throttle || (e && e.name === 'Offline')) {
        backoff = backoff ? Math.min(backoff * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
        // the longer of Retry-After and the backoff: a Retry-After of 0 (or empty) never means "at once"
        wait = throttle && Number.isFinite(e.retryAfterMs) ? Math.max(e.retryAfterMs, backoff) : backoff;
        if (throttle && !throttled) { throttled = true; onThrottle(THROTTLE_NOTE); }
      } else onError(e);
    } finally { running = false; }
    schedule(wait);
  }

  return {
    start() { if (!stopped) return; stopped = false; tick(); },
    stop() { stopped = true; if (timer !== null) { timers.clear(timer); timer = null; } },
    /** Run now, unless a run is in flight. */
    kick() { if (stopped || running) return; if (timer !== null) { timers.clear(timer); timer = null; } tick(); },
  };
}

module.exports = { createPoller, UNFOCUSED_FACTOR, BACKOFF_START_MS, BACKOFF_MAX_MS, THROTTLE_NOTE };
