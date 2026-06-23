// A minimal one-producer / one-consumer async queue that backs the engine's live
// event stream. The pipeline driver `push`es RunEvents as they happen;
// the run generator iterates. It is *pull-based*, so a slow consumer applies
// natural backpressure on iteration — there is no callback that can outrun a TUI.
//
// `close()` ends iteration after the buffer drains and is terminal and idempotent.
//
// NOTE: the buffer is unbounded. A persistently slow consumer lets it grow; a hard
// bound (drop / coalesce policy) is deliberately deferred until a real consumer
// needs it (see 0004 spec, Open Question 4) — not silently handled here.

interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
}

export interface EventQueue<T> {
  push(event: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export function createEventQueue<T>(): EventQueue<T> {
  const buffer: T[] = [];
  let waiter: Waiter<T> | null = null;
  let closed = false;

  const takeWaiter = (): Waiter<T> | null => {
    const w = waiter;
    waiter = null;
    return w;
  };

  return {
    push(event) {
      if (closed) return; // terminal — ignore late producers
      const w = takeWaiter();
      if (w) w.resolve({ value: event, done: false });
      else buffer.push(event);
    },

    close() {
      if (closed) return;
      closed = true;
      takeWaiter()?.resolve({ value: undefined as never, done: true });
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          // Buffered events drain before close surfaces.
          if (buffer.length > 0)
            return Promise.resolve({ value: buffer.shift() as T, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise<IteratorResult<T>>((resolve) => {
            waiter = { resolve };
          });
        },
      };
    },
  };
}
