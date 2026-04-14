 class AsyncQueue<T> implements AsyncIterable<T> { // 它“可以被迭代”（准确说是 可异步迭代 ）
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private finished = false;

  push(value: T): void {
    if (this.finished) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  end(): void {
    this.finished = true;
    while (this.resolvers.length) {
      this.resolvers.shift()?.({ value: undefined as T, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.values.length) {
      return { value: this.values.shift() as T, done: false };
    }
    if (this.finished) {
      return { value: undefined as T, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }
}
(async () => {
  const queue = new AsyncQueue<number>();

  const producer = async () => {
    for (let i = 1; i <= 5; i += 1) {
      queue.push(i);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    queue.end();
  };

  const consumer = async () => {
    for await (const value of queue) {
      console.log(`消费到: ${value}`);
    }
    console.log("消费结束");
  };

//   await Promise.all([producer(), consumer()]);
})();

(async () => {
  console.log("--- resolver 示例开始 ---");
  const queue = new AsyncQueue<string>();

  // 先消费：当前队列为空，next() 会把 resolve 放入 resolvers 等待后续 push 唤醒
  const pending = queue.next();

  setTimeout(() => {
    queue.push("第一个值(由 resolver 立即交付)");
    queue.end();
  }, 2000);

  const first = await pending;
  console.log("next() 返回:", first);

  const done = await queue.next();
  console.log("结束信号:", done);
  console.log("--- resolver 示例结束 ---");
})();
