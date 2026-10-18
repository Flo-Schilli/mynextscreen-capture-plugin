// SPDX-License-Identifier: Apache-2.0
import { BoundedQueue } from './bounded-queue.js';

describe('BoundedQueue', () => {
  it('returns items in order', () => {
    const queue = new BoundedQueue<number>(3);
    queue.push(1);
    queue.push(2);

    expect([queue.shift(), queue.shift(), queue.shift()]).toEqual([1, 2, undefined]);
  });

  it('drops the oldest item when full and counts it', () => {
    const queue = new BoundedQueue<number>(2);
    [1, 2, 3, 4].forEach((n) => queue.push(n));

    expect(queue.length).toBe(2);
    expect(queue.dropped).toBe(2);
    expect([queue.shift(), queue.shift()]).toEqual([3, 4]);
  });
});
