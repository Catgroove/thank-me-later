import { describe, expect, test } from "bun:test";
import { createEventQueue } from "../src/queue.ts";

async function drain<T>(queue: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

describe("createEventQueue", () => {
  test("drains events pushed before iteration, in order, then ends on close", async () => {
    const q = createEventQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    expect(await drain(q)).toEqual([1, 2, 3]);
  });

  test("a consumer waiting ahead of the producer resolves on the next push", async () => {
    const q = createEventQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next(); // no buffered events yet — awaits
    q.push("late");
    expect(await pending).toEqual({ value: "late", done: false });
  });

  test("close after a partial drain ends iteration once the buffer empties", async () => {
    const q = createEventQueue<number>();
    q.push(1);
    const iterator = q[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    q.close();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  test("push and close are ignored after a terminal state", async () => {
    const q = createEventQueue<number>();
    q.close();
    q.push(99); // ignored
    expect(await drain(q)).toEqual([]);
  });
});
