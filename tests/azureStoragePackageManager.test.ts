import { once } from 'node:events';
import { PassThrough, Readable, type Stream } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import type { pluginUtils } from '@verdaccio/core';
import type { Manifest } from '@verdaccio/types';
import { describe, expect, test } from 'vitest';
import AzureStoragePackageManager from '../src/azureStoragePackageManager';
import { type AzureStorageConfig, parseAzureStorageConfig } from '../src/azureStoragePluginConfig';
import { PackageUpdates } from '../src/packageUpdates';
import { AZURITE_CONNECTION_STRING, abortError, azureError, fakeLogger, MemoryContainer } from './fakes';

const TARBALL = 'pkg-1.0.0.tgz';

// events.once rejects when 'error' comes first, so a stream that fails needs its own wait for 'close'.
const closeOf = (stream: Stream): Promise<void> => new Promise((resolve) => stream.once('close', () => resolve()));

function settings(extra: Record<string, unknown> = {}): AzureStorageConfig {
  return parseAzureStorageConfig(
    { connectionString: AZURITE_CONNECTION_STRING, containerName: 'verdaccio', ...extra },
    {},
  );
}

function manifestOf(name: string, extra: Partial<Manifest> = {}): Manifest {
  return {
    name,
    'dist-tags': {},
    time: {},
    versions: {},
    _attachments: {},
    _distfiles: {},
    _uplinks: {},
    _rev: '1-a',
    ...extra,
  };
}

function setup({
  packageName = 'pkg',
  config = settings(),
  container = new MemoryContainer(),
  updates = new PackageUpdates(),
} = {}) {
  // Typed as the interface the store calls, with the package name it passes.
  const handler = (): pluginUtils.StorageHandler =>
    new AzureStoragePackageManager(packageName, config, fakeLogger(), container, updates);
  return { container, updates, handler, manager: handler() };
}

describe('blob names', () => {
  test.each([
    ['pkg', settings(), 'packages/pkg/package.json'],
    ['@scope/pkg', settings(), 'packages/@scope/pkg/package.json'],
    ['pkg', settings({ packagesDir: 'custom/dir' }), 'custom/dir/pkg/package.json'],
  ])('%s is kept at the 1.x path', async (packageName, config, blobName) => {
    const { manager, container } = setup({ packageName, config });
    await manager.savePackage(packageName, manifestOf(packageName));
    expect([...container.blobs.keys()]).toEqual([blobName]);
  });

  test('a tarball sits next to its manifest', async () => {
    const { manager, container } = setup({ packageName: '@scope/pkg' });
    await pipeline(
      Readable.from([Buffer.from('tarball')]),
      await manager.writeTarball(TARBALL, { signal: new AbortController().signal }),
    );
    expect([...container.blobs.keys()]).toEqual([`packages/@scope/pkg/${TARBALL}`]);
  });

  test.each(['..', '.', '@scope/..', 'a//b'])('the unsafe package name %s is refused', (packageName) => {
    expect(() => setup({ packageName })).toThrow(expect.objectContaining({ code: 500 }));
  });

  test('an unsafe file name is refused before any request', async () => {
    const { manager, container } = setup();
    await expect(manager.deletePackage('../../.verdaccio-db.json')).rejects.toMatchObject({ code: 500 });
    expect(container.getBlockBlobClient('.verdaccio-db.json').deleteIfExists).not.toHaveBeenCalled();
  });
});

describe('manifests', () => {
  test('readPackage returns the stored document, even one that is not a manifest', async () => {
    const { manager, container } = setup();
    container.seed('packages/pkg/package.json', JSON.stringify({ items: [] }));
    await expect(manager.readPackage('pkg')).resolves.toEqual({ items: [] });
  });

  test('readPackage of a missing manifest rejects with 404', async () => {
    await expect(setup().manager.readPackage('pkg')).rejects.toMatchObject({ code: 404 });
  });

  test.each([
    ['invalid JSON', '{'],
    ['a JSON value that is not an object', '[]'],
  ])('readPackage of %s rejects with 500', async (_case, content) => {
    const { manager, container } = setup();
    container.seed('packages/pkg/package.json', content);
    await expect(manager.readPackage('pkg')).rejects.toMatchObject({ code: 500 });
  });

  test('readPackage maps a failed request', async () => {
    const { manager, container } = setup();
    container
      .getBlockBlobClient('packages/pkg/package.json')
      .download.mockRejectedValueOnce(azureError(503, 'ServerBusy'));
    await expect(manager.readPackage('pkg')).rejects.toMatchObject({ code: 503 });
  });

  test('hasPackage tells whether the manifest exists', async () => {
    const { manager, container } = setup();
    await expect(manager.hasPackage('pkg')).resolves.toBe(false);
    container.seed('packages/pkg/package.json', '{}');
    await expect(manager.hasPackage('pkg')).resolves.toBe(true);
  });

  test('hasPackage maps a failed request', async () => {
    const { manager, container } = setup();
    container
      .getBlockBlobClient('packages/pkg/package.json')
      .exists.mockRejectedValueOnce(azureError(403, 'AuthorizationFailure'));
    await expect(manager.hasPackage('pkg')).rejects.toMatchObject({ code: 500 });
  });

  test('createPackage writes create-only JSON', async () => {
    const { manager, container } = setup();
    await manager.createPackage('pkg', manifestOf('pkg'));
    expect(container.getBlockBlobClient('packages/pkg/package.json').uploadData).toHaveBeenCalledWith(
      expect.any(Buffer),
      {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: { ifNoneMatch: '*' },
      },
    );
    expect(JSON.parse(container.textOf('packages/pkg/package.json') ?? '')).toEqual(manifestOf('pkg'));
  });

  test('createPackage of an existing manifest rejects with 409 and keeps it', async () => {
    const { manager, container } = setup();
    container.seed('packages/pkg/package.json', JSON.stringify(manifestOf('pkg', { _rev: 'first' })));
    await expect(manager.createPackage('pkg', manifestOf('pkg'))).rejects.toMatchObject({ code: 409 });
    expect(JSON.parse(container.textOf('packages/pkg/package.json') ?? '')).toMatchObject({ _rev: 'first' });
  });

  test('savePackage outside an update is unconditional and sets the configured Cache-Control', async () => {
    const { manager, container } = setup({ config: settings({ cachePackageDataTime: 300 }) });
    container.seed('packages/pkg/package.json', '{}');
    await manager.savePackage('pkg', manifestOf('pkg'));
    expect(container.getBlockBlobClient('packages/pkg/package.json').uploadData).toHaveBeenCalledWith(
      expect.any(Buffer),
      {
        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' },
        conditions: {},
      },
    );
  });

  test('deletePackage deletes the blob and succeeds when it is already gone', async () => {
    const { manager, container } = setup();
    container.seed(`packages/pkg/${TARBALL}`, 'tarball');
    await manager.deletePackage(TARBALL);
    await manager.deletePackage(TARBALL);
    expect(container.blobs.size).toBe(0);
  });

  test('deletePackage maps a failed request', async () => {
    const { manager, container } = setup();
    container
      .getBlockBlobClient(`packages/pkg/${TARBALL}`)
      .deleteIfExists.mockRejectedValueOnce(azureError(404, 'ContainerNotFound'));
    await expect(manager.deletePackage(TARBALL)).rejects.toMatchObject({ code: 500 });
  });

  test('removePackage has nothing to remove', async () => {
    await expect(setup().manager.removePackage('pkg')).resolves.toBeUndefined();
  });
});

describe('updatePackage', () => {
  // The store reads with one handler and saves with a new one from inside the callback.
  const storeUpdate = (handler: () => pluginUtils.StorageHandler, change: (manifest: Manifest) => Manifest) =>
    handler().updatePackage('pkg', async (manifest) => {
      const updated = change(manifest);
      await handler().savePackage('pkg', updated);
      return updated;
    });

  test('the save from another handler carries If-Match with the ETag that was read', async () => {
    const { handler, container } = setup();
    const etag = container.seed('packages/pkg/package.json', JSON.stringify(manifestOf('pkg')));
    await expect(storeUpdate(handler, (manifest) => ({ ...manifest, _rev: '2-b' }))).resolves.toMatchObject({
      _rev: '2-b',
    });
    expect(container.getBlockBlobClient('packages/pkg/package.json').uploadData).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ conditions: { ifMatch: etag } }),
    );
  });

  test('a manifest written by someone else after the read makes the save fail with 409', async () => {
    const { handler, container } = setup();
    container.seed('packages/pkg/package.json', JSON.stringify(manifestOf('pkg')));
    const update = handler().updatePackage('pkg', async (manifest) => {
      container.seed('packages/pkg/package.json', JSON.stringify(manifestOf('pkg', { _rev: 'other-writer' })));
      await handler().savePackage('pkg', manifest);
      return manifest;
    });
    await expect(update).rejects.toMatchObject({ code: 409 });
    expect(JSON.parse(container.textOf('packages/pkg/package.json') ?? '')).toMatchObject({ _rev: 'other-writer' });
  });

  test('a missing manifest rejects with 404 without calling the callback', async () => {
    const { manager } = setup();
    let called = false;
    const update = manager.updatePackage('pkg', async (manifest) => {
      called = true;
      return manifest;
    });
    await expect(update).rejects.toMatchObject({ code: 404 });
    expect(called).toBe(false);
  });

  test('concurrent updates of one package run one after another and keep both changes', async () => {
    const { handler, container } = setup();
    container.seed('packages/pkg/package.json', JSON.stringify(manifestOf('pkg')));
    const tag = (name: string) => (manifest: Manifest) => ({
      ...manifest,
      'dist-tags': { ...manifest['dist-tags'], [name]: '1.0.0' },
    });
    await Promise.all([storeUpdate(handler, tag('first')), storeUpdate(handler, tag('second'))]);
    expect(JSON.parse(container.textOf('packages/pkg/package.json') ?? '')['dist-tags']).toEqual({
      first: '1.0.0',
      second: '1.0.0',
    });
  });
});

describe('readTarball', () => {
  test('emits content-length, then open, then the data', async () => {
    const { manager, container } = setup();
    container.seed(`packages/pkg/${TARBALL}`, 'tarball-bytes');
    const tarball = await manager.readTarball(TARBALL, { signal: new AbortController().signal });
    const events: unknown[] = [];
    tarball.on('content-length', (size) => events.push(['content-length', size]));
    tarball.on('open', () => events.push(['open']));
    tarball.on('data', (chunk: Buffer) => events.push(['data', chunk.toString('utf8')]));
    await once(tarball, 'end');
    expect(events).toEqual([['content-length', 13], ['open'], ['data', 'tarball-bytes']]);
  });

  test('a missing tarball arrives as an error event with code 404, not as a rejection', async () => {
    const tarball = await setup().manager.readTarball(TARBALL, { signal: new AbortController().signal });
    const [error] = await once(tarball, 'error');
    expect(error).toMatchObject({ code: 404 });
  });

  test('a failed request arrives as an error event that is not 404', async () => {
    const { manager, container } = setup();
    container
      .getBlockBlobClient(`packages/pkg/${TARBALL}`)
      .download.mockRejectedValueOnce(azureError(404, 'ContainerNotFound'));
    const tarball = await manager.readTarball(TARBALL, { signal: new AbortController().signal });
    const [error] = await once(tarball, 'error');
    expect(error).toMatchObject({ code: 500 });
  });

  test('the abort signal reaches the download and destroys the stream', async () => {
    const { manager, container } = setup();
    container.seed(`packages/pkg/${TARBALL}`, 'tarball-bytes');
    const abort = new AbortController();
    const tarball = await manager.readTarball(TARBALL, { signal: abort.signal });
    abort.abort();
    const [error] = await once(tarball, 'error');
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(tarball.destroyed).toBe(true);
    expect(container.getBlockBlobClient(`packages/pkg/${TARBALL}`).download).toHaveBeenCalledWith(0, undefined, {
      abortSignal: abort.signal,
    });
  });

  test('a body that fails during the transfer fails the stream with that error, never with 404', async () => {
    const { manager, container } = setup();
    const body = new PassThrough();
    container.getBlockBlobClient(`packages/pkg/${TARBALL}`).download.mockImplementationOnce(async () => {
      await setImmediate();
      return { etag: '"0x1"', contentLength: 100, readableStreamBody: body };
    });
    const tarball = await manager.readTarball(TARBALL, { signal: new AbortController().signal });
    await once(tarball, 'open');
    body.write('partial');
    body.destroy(new Error('connection reset'));
    const [error] = await once(tarball, 'error');
    expect(error).toMatchObject({ message: 'connection reset' });
    expect(error).not.toMatchObject({ code: 404 });
  });

  test('hasTarball tells whether the tarball exists', async () => {
    const { manager, container } = setup();
    await expect(manager.hasTarball(TARBALL)).resolves.toBe(false);
    container.seed(`packages/pkg/${TARBALL}`, 'tarball');
    await expect(manager.hasTarball(TARBALL)).resolves.toBe(true);
  });
});

describe('writeTarball', () => {
  const signal = () => new AbortController().signal;

  test('finishes and closes only after the blob was committed', async () => {
    const { manager, container } = setup({ config: settings({ cachePackageTime: 600 }) });
    const tarball = await manager.writeTarball(TARBALL, { signal: signal() });
    let committedAtFinish = false;
    tarball.on('finish', () => {
      committedAtFinish = container.blobs.has(`packages/pkg/${TARBALL}`);
    });
    const closed = closeOf(tarball);
    await pipeline(Readable.from([Buffer.from('tarball-'), Buffer.from('bytes')]), tarball);
    await closed;
    expect(committedAtFinish).toBe(true);
    expect(tarball.writableFinished).toBe(true);
    expect(container.textOf(`packages/pkg/${TARBALL}`)).toBe('tarball-bytes');
    expect(container.blobs.get(`packages/pkg/${TARBALL}`)?.headers).toEqual({
      blobContentType: 'application/x-compressed-tar',
      blobCacheControl: 'public, max-age=600',
    });
  });

  test('a failed commit errors the stream, which never counts as finished', async () => {
    const { manager, container } = setup();
    const blob = container.getBlockBlobClient(`packages/pkg/${TARBALL}`);
    blob.uploadStream.mockImplementationOnce(
      (stream) =>
        new Promise((_resolve, reject) => {
          stream.resume();
          stream.on('error', reject);
          stream.on('end', () => reject(azureError(403, 'AuthorizationPermissionMismatch')));
        }),
    );
    const tarball = await manager.writeTarball(TARBALL, { signal: signal() });
    const closed = closeOf(tarball);
    await expect(pipeline(Readable.from([Buffer.from('tarball')]), tarball)).rejects.toMatchObject({ code: 500 });
    await closed;
    expect(tarball.writableFinished).toBe(false);
    expect(container.blobs.size).toBe(0);
  });

  test('a destroy without an error cancels the upload, which commits nothing', async () => {
    const { manager, container } = setup();
    const tarball = await manager.writeTarball(TARBALL, { signal: signal() });
    tarball.write(Buffer.from('partial'));
    tarball.destroy();
    const [upload] = container.getBlockBlobClient(`packages/pkg/${TARBALL}`).uploadStream.mock.results;
    await expect(upload?.value).rejects.toMatchObject({ message: 'tarball upload cancelled' });
    expect(container.blobs.size).toBe(0);
  });

  test('the abort signal cancels the upload', async () => {
    const { manager, container } = setup();
    const abort = new AbortController();
    const tarball = await manager.writeTarball(TARBALL, { signal: abort.signal });
    tarball.write(Buffer.from('partial'));
    abort.abort();
    const [error] = await once(tarball, 'error');
    expect(error).toMatchObject({ name: 'AbortError' });
    const [upload] = container.getBlockBlobClient(`packages/pkg/${TARBALL}`).uploadStream.mock.results;
    await expect(upload?.value).rejects.toMatchObject({ name: 'AbortError' });
    expect(container.blobs.size).toBe(0);
  });

  test('a block that fails to upload fails the writer at once, even while a write waits for drain', async () => {
    const { manager, container } = setup();
    const blob = container.getBlockBlobClient(`packages/pkg/${TARBALL}`);
    // Like the SDK: a failed stage pauses the source and rejects, so 'drain' never comes.
    blob.uploadStream.mockImplementationOnce(
      (stream) =>
        new Promise((_resolve, reject) => {
          stream.on('error', reject);
          stream.once('data', () => {
            stream.pause();
            setImmediate().then(() => reject(azureError(503, 'ServerBusy')));
          });
        }),
    );
    const tarball = await manager.writeTarball(TARBALL, { signal: signal() });
    const failed = once(tarball, 'error');
    const chunk = Buffer.alloc(64 * 1024);
    tarball.write(chunk);
    tarball.write(chunk);
    const [error] = await failed;
    expect(error).toMatchObject({ code: 503 });
    expect(container.blobs.size).toBe(0);
  });

  test('a stream that errors before anyone listens does not end the process', async () => {
    const abort = new AbortController();
    abort.abort(abortError());
    const tarball = await setup().manager.writeTarball(TARBALL, { signal: abort.signal });
    await setImmediate();
    expect(tarball.destroyed).toBe(true);
  });
});
