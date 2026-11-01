import { AsyncLocalStorage } from 'node:async_hooks';
import type { BlobRequestConditions } from '@azure/storage-blob';

/** Runs tasks one after another per key; tasks with different keys run in parallel. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail: Promise<void> = result.then(
      () => this.release(key, tail),
      () => this.release(key, tail),
    );
    this.tails.set(key, tail);
    return result;
  }

  // Forget a key after its last task, so the map does not grow with every package ever updated.
  private release(key: string, tail: Promise<void>): void {
    if (this.tails.get(key) === tail) {
      this.tails.delete(key);
    }
  }
}

type OpenUpdate = { blobName: string; etag: string };

/**
 * Serializes the read-modify-write updates of each manifest in this process, and gives the
 * ETag that an update read to the saves made inside it.
 *
 * The store saves through `savePackage` on a new handler from inside `updatePackage`, so the
 * ETag cannot live on the handler. The async context ties a save to its update: a save made
 * outside every update, such as the uplink cache refresh, stays unconditional.
 */
export class PackageUpdates {
  private readonly queue = new KeyedQueue();
  private readonly openUpdate = new AsyncLocalStorage<OpenUpdate>();

  update<Document, Result>(
    blobName: string,
    read: () => Promise<{ document: Document; etag: string }>,
    handle: (document: Document) => Promise<Result>,
  ): Promise<Result> {
    return this.queue.run(blobName, async () => {
      const { document, etag } = await read();
      return this.openUpdate.run({ blobName, etag }, () => handle(document));
    });
  }

  conditionsFor(blobName: string): BlobRequestConditions {
    const open = this.openUpdate.getStore();
    return open?.blobName === blobName ? { ifMatch: open.etag } : {};
  }
}
