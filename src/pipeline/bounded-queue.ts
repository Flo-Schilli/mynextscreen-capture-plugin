// SPDX-License-Identifier: Apache-2.0
/** FIFO with fixed capacity; pushing into a full queue drops the oldest entry. */
export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private droppedCount = 0;

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
      this.droppedCount += 1;
    }
    this.items.push(item);
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  get length(): number {
    return this.items.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }
}
