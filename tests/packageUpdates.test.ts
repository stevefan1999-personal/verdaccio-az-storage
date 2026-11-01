import { setImmediate } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { KeyedQueue, PackageUpdates } from '../src/packageUpdates';

const MANIFEST = 'packages/pkg/package.json';
const OTHER_MANIFEST = 'packages/other/package.json';

function deferred() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('KeyedQueue', () => {
  test('runs tasks with the same key one after another', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];
    const gate = deferred();
    const first = queue.run('key', async () => {
      events.push('first started');
      await gate.promise;
      events.push('first ended');
    });
    const second = queue.run('key', async () => {
      events.push('second started');
    });
    await setImmediate();
    expect(events).toEqual(['first started']);
    gate.release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first started', 'first ended', 'second started']);
  });

  test('runs tasks with different keys in parallel', async () => {
    const queue = new KeyedQueue();
    const gate = deferred();
    const blocked = queue.run('first', () => gate.promise);
    await expect(queue.run('second', async () => 'ran')).resolves.toBe('ran');
    gate.release();
    await blocked;
  });

  test('a rejected task does not block the next one', async () => {
    const queue = new KeyedQueue();
    const failing = queue.run('key', async () => {
      throw new Error('task failed');
    });
    await expect(queue.run('key', async () => 'next')).resolves.toBe('next');
    await expect(failing).rejects.toThrow('task failed');
  });

  test('forgets a key once its last task settled', async () => {
    const queue = new KeyedQueue();
    await queue.run('done', async () => undefined);
    await queue.run('failed', async () => Promise.reject(new Error('task failed'))).catch(() => undefined);
    await setImmediate();
    expect(Reflect.get(queue, 'tails')).toEqual(new Map());
  });
});

describe('PackageUpdates', () => {
  const read = (etag: string) => async () => ({ document: { name: 'pkg' }, etag });

  test('a save inside the update gets If-Match with the ETag the update read', async () => {
    const updates = new PackageUpdates();
    const conditions = await updates.update(MANIFEST, read('"0x1"'), async () => {
      await setImmediate();
      return updates.conditionsFor(MANIFEST);
    });
    expect(conditions).toEqual({ ifMatch: '"0x1"' });
  });

  test('a save of another blob inside the update is unconditional', async () => {
    const updates = new PackageUpdates();
    await expect(
      updates.update(MANIFEST, read('"0x1"'), async () => updates.conditionsFor(OTHER_MANIFEST)),
    ).resolves.toEqual({});
  });

  test('a save outside every update is unconditional, even while an update of the blob is open', async () => {
    const updates = new PackageUpdates();
    const gate = deferred();
    const open = updates.update(MANIFEST, read('"0x1"'), () => gate.promise);
    await setImmediate();
    expect(updates.conditionsFor(MANIFEST)).toEqual({});
    gate.release();
    await open;
  });

  test('no condition is left after an update succeeded or failed', async () => {
    const updates = new PackageUpdates();
    await updates.update(MANIFEST, read('"0x1"'), async () => undefined);
    await updates
      .update(MANIFEST, read('"0x2"'), async () => {
        throw new Error('handler failed');
      })
      .catch(() => undefined);
    expect(updates.conditionsFor(MANIFEST)).toEqual({});
  });

  test('a failed read rejects without running the handler', async () => {
    const updates = new PackageUpdates();
    let handled = false;
    const failing = updates.update(
      MANIFEST,
      async () => Promise.reject(new Error('read failed')),
      async () => {
        handled = true;
      },
    );
    await expect(failing).rejects.toThrow('read failed');
    expect(handled).toBe(false);
  });

  test('updates of the same blob run one after another, and each reads after the previous one ended', async () => {
    const updates = new PackageUpdates();
    const events: string[] = [];
    const reading = (name: string) => async () => {
      events.push(`${name} read`);
      return { document: name, etag: `"${name}"` };
    };
    const handling = (name: string) => async () => {
      await setImmediate();
      events.push(`${name} saved with ${JSON.stringify(updates.conditionsFor(MANIFEST))}`);
    };
    await Promise.all([
      updates.update(MANIFEST, reading('first'), handling('first')),
      updates.update(MANIFEST, reading('second'), handling('second')),
    ]);
    expect(events).toEqual([
      'first read',
      'first saved with {"ifMatch":"\\"first\\""}',
      'second read',
      'second saved with {"ifMatch":"\\"second\\""}',
    ]);
  });
});
