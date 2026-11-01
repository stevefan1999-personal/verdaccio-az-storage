import { describe, expect, test, vi } from 'vitest';
import {
  DATABASE_WRITE_ATTEMPTS,
  type ILocalStorageProvider,
  type LocalStorage,
  LocalStorageDatabase,
  StorageBlobLocalStorageProvider,
  type StoredLocalStorage,
  type WriteOutcome,
} from '../src/localStorage';
import { azureError, MemoryContainer } from './fakes';

const DATABASE = '.verdaccio-db.json';
const EMPTY: LocalStorage = { list: [], secret: '', tokens: [] };

const addPackage =
  (name: string) =>
  (current: LocalStorage): LocalStorage => ({ ...current, list: [...current.list, name] });

function blobDatabase(container = new MemoryContainer()) {
  const blob = container.getBlockBlobClient(DATABASE);
  return { container, blob, database: new LocalStorageDatabase(new StorageBlobLocalStorageProvider(blob)) };
}

function scriptedProvider(outcome: WriteOutcome, stored: StoredLocalStorage = { kind: 'missing' }) {
  const provider = {
    read: vi.fn(async (): Promise<StoredLocalStorage> => stored),
    write: vi.fn(async (_next: LocalStorage, _previous: StoredLocalStorage): Promise<WriteOutcome> => outcome),
  } satisfies ILocalStorageProvider;
  return { provider, database: new LocalStorageDatabase(provider) };
}

const storedList = (container: MemoryContainer): unknown => JSON.parse(container.textOf(DATABASE) ?? 'null')?.list;

describe('LocalStorageDatabase', () => {
  test('a missing document reads as empty and is not written', async () => {
    const { database, blob } = blobDatabase();
    await expect(database.read()).resolves.toEqual(EMPTY);
    expect(blob.uploadData).not.toHaveBeenCalled();
  });

  test('the first change creates the document', async () => {
    const { database, container } = blobDatabase();
    await database.update(addPackage('first'));
    expect(storedList(container)).toEqual(['first']);
  });

  test('a change that changes nothing does not write', async () => {
    const { database, blob } = blobDatabase();
    await database.update((current) => ({ ...current, list: current.list.filter((name) => name !== 'absent') }));
    expect(blob.uploadData).not.toHaveBeenCalled();
  });

  test('two writers that race both keep their change, because the loser reads and applies again', async () => {
    const container = new MemoryContainer();
    const first = blobDatabase(container);
    const second = blobDatabase(container);
    await Promise.all([
      first.database.update(addPackage('from-first')),
      second.database.update(addPackage('from-second')),
    ]);
    expect(storedList(container)).toEqual(expect.arrayContaining(['from-first', 'from-second']));
    // two create-only writes, one of which lost, and the loser's If-Match retry
    expect(first.blob.uploadData).toHaveBeenCalledTimes(3);
  });

  test(`a write that loses every race fails with 409 after ${DATABASE_WRITE_ATTEMPTS} attempts`, async () => {
    const { database, provider } = scriptedProvider('conflict');
    await expect(database.update(addPackage('never'))).rejects.toMatchObject({ code: 409 });
    expect(provider.read).toHaveBeenCalledTimes(DATABASE_WRITE_ATTEMPTS);
    expect(provider.write).toHaveBeenCalledTimes(DATABASE_WRITE_ATTEMPTS);
  });

  test('a read that fails during a change writes nothing', async () => {
    const { database, blob } = blobDatabase();
    blob.download.mockRejectedValueOnce(azureError(403, 'AuthorizationFailure'));
    await expect(database.update(addPackage('lost'))).rejects.toMatchObject({ code: 500 });
    expect(blob.uploadData).not.toHaveBeenCalled();
  });

  test('changes in one process run one after another, so none of them conflicts', async () => {
    const { database, blob, container } = blobDatabase();
    const names = Array.from({ length: 10 }, (_, index) => `package-${index}`);
    await Promise.all(names.map((name) => database.update(addPackage(name))));
    expect(storedList(container)).toEqual(names);
    expect(blob.uploadData).toHaveBeenCalledTimes(names.length);
  });

  test('a change that fails does not block the next one', async () => {
    const { database, container } = blobDatabase();
    const failing = database.update(() => {
      throw new Error('change failed');
    });
    const next = database.update(addPackage('after'));
    await expect(failing).rejects.toThrow('change failed');
    await next;
    expect(storedList(container)).toEqual(['after']);
  });
});
