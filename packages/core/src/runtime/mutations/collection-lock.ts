/** Shared entry operations and exclusive collection management, within one process. */
type Waiter = { exclusive: boolean; grant(): void };
type State = { readers: number; writing: boolean; queue: Waiter[] };
const states = new Map<string, State>();

function acquire(collection: string, exclusive: boolean): Promise<() => void> {
  let state = states.get(collection);
  if (!state) { state = { readers: 0, writing: false, queue: [] }; states.set(collection, state); }
  const current = state;
  function drain() {
    if (current.writing) return;
    while (current.queue.length) {
      const next = current.queue[0];
      if (next.exclusive && current.readers) return;
      current.queue.shift();
      next.grant();
      if (next.exclusive) return;
    }
    if (!current.readers) states.delete(collection);
  }
  return new Promise(resolve => {
    current.queue.push({ exclusive, grant() {
      if (exclusive) current.writing = true;
      else current.readers++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        if (exclusive) current.writing = false;
        else current.readers--;
        drain();
      });
    } });
    drain();
  });
}

/** Non-reentrant. Acquire shared collections in a stable order before entry locks. */
export async function withCollectionReads<T>(collections: readonly string[], task: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  try {
    for (const collection of [...new Set(collections)].sort()) releases.push(await acquire(collection, false));
    return await task();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export async function withCollectionWrite<T>(collection: string, task: () => Promise<T>): Promise<T> {
  const release = await acquire(collection, true);
  try { return await task(); }
  finally { release(); }
}
