/**
 * Trailing-edge debounce. Delays `fn` until `waitMs` has elapsed since
 * the most recent call. Coalesces bursts into a single invocation with
 * the most recent arguments.
 *
 * Used by fs.watch consumers (skills, plugins) where macOS FSEvents
 * delivers many duplicate events for a single logical change.
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs: number,
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Args | null = null;

  return function debounced(...args: Args): void {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const call = lastArgs;
      lastArgs = null;
      if (call) fn(...call);
    }, waitMs);
  };
}
