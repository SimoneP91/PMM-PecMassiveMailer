/**
 * Replaceable waiting. The loops sleep between polls, between paced sends and
 * while a mailbox is suspended; a shutdown must cut every one of those
 * short, and a test must not have to wait for real.
 */
export interface Sleeper {
  /** Resolves after the delay, or as soon as the signal aborts. Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemSleeper implements Sleeper {
  public sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true || ms <= 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
