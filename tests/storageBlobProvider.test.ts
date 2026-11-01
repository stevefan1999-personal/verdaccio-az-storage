import { RestError } from '@azure/storage-blob';
import { describe, expect, test } from 'vitest';
import { type LocalStorage, StorageBlobLocalStorageProvider } from '../src/localStorage';
import { azureError, MemoryContainer } from './fakes';

const DATABASE = '.verdaccio-db.json';
const SECRET = 'a'.repeat(32);
const DOCUMENT: LocalStorage = { list: ['pkg'], secret: SECRET, tokens: [] };

function providerWith(content?: string) {
  const container = new MemoryContainer();
  const etag = content === undefined ? undefined : container.seed(DATABASE, content);
  const blob = container.getBlockBlobClient(DATABASE);
  return { container, blob, etag, provider: new StorageBlobLocalStorageProvider(blob) };
}

describe('StorageBlobLocalStorageProvider.read', () => {
  test('returns the document with its ETag and keeps keys it does not know', async () => {
    const { provider, etag } = providerWith(JSON.stringify({ ...DOCUMENT, futureKey: { kept: true } }));
    await expect(provider.read()).resolves.toEqual({
      kind: 'present',
      document: { ...DOCUMENT, futureKey: { kept: true } },
      etag,
    });
  });

  test('reads a 1.x document, which has no tokens, with an empty token list', async () => {
    const { provider } = providerWith(JSON.stringify({ list: ['old'], secret: SECRET }));
    await expect(provider.read()).resolves.toMatchObject({ document: { list: ['old'], secret: SECRET, tokens: [] } });
  });

  test('a definite BlobNotFound reads as missing', async () => {
    await expect(providerWith().provider.read()).resolves.toEqual({ kind: 'missing' });
  });

  test.each([
    ['ContainerNotFound', azureError(404, 'ContainerNotFound'), 500],
    ['AuthorizationFailure', azureError(403, 'AuthorizationFailure'), 500],
    ['ServerBusy', azureError(503, 'ServerBusy'), 503],
    ['no response', new RestError('socket hang up', { code: 'REQUEST_SEND_ERROR' }), 503],
  ])('%s rejects instead of reading as missing', async (_case, error, code) => {
    const { provider, blob } = providerWith();
    blob.download.mockRejectedValueOnce(error);
    await expect(provider.read()).rejects.toMatchObject({ code });
  });

  test('invalid JSON rejects without quoting the document, which V8 would do', async () => {
    const { provider } = providerWith(`{"secret":${SECRET}}`);
    await expect(provider.read()).rejects.toMatchObject({
      code: 500,
      message: 'the verdaccio database is not valid JSON',
    });
  });

  test('a document of the wrong shape rejects without quoting it', async () => {
    const { provider } = providerWith(JSON.stringify({ list: 'pkg', secret: SECRET }));
    const failure = provider.read();
    await expect(failure).rejects.toMatchObject({ code: 500, message: expect.stringContaining('at list') });
    await expect(failure).rejects.not.toHaveProperty('message', expect.stringContaining(SECRET));
  });
});

describe('StorageBlobLocalStorageProvider.write', () => {
  test('creates the document only if it is still missing', async () => {
    const { provider, blob, container } = providerWith();
    await expect(provider.write(DOCUMENT, { kind: 'missing' })).resolves.toBe('written');
    expect(blob.uploadData).toHaveBeenCalledWith(expect.any(Buffer), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      conditions: { ifNoneMatch: '*' },
    });
    expect(JSON.parse(container.textOf(DATABASE) ?? '')).toEqual(DOCUMENT);
  });

  test('a create that finds a document is a conflict and leaves that document alone', async () => {
    const { provider, container } = providerWith(JSON.stringify(DOCUMENT));
    await expect(provider.write({ list: [], secret: '', tokens: [] }, { kind: 'missing' })).resolves.toBe('conflict');
    expect(JSON.parse(container.textOf(DATABASE) ?? '')).toEqual(DOCUMENT);
  });

  test('replaces the document only while its ETag still matches', async () => {
    const { provider, blob, etag } = providerWith(JSON.stringify(DOCUMENT));
    const previous = await provider.read();
    await expect(provider.write({ ...DOCUMENT, list: ['pkg', 'next'] }, previous)).resolves.toBe('written');
    expect(blob.uploadData).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ conditions: { ifMatch: etag } }),
    );
    await expect(provider.write({ ...DOCUMENT, list: [] }, previous)).resolves.toBe('conflict');
  });

  test('other failures reject', async () => {
    const { provider, blob } = providerWith();
    blob.uploadData.mockRejectedValueOnce(azureError(403, 'AuthorizationPermissionMismatch'));
    await expect(provider.write(DOCUMENT, { kind: 'missing' })).rejects.toMatchObject({ code: 500 });
  });
});
