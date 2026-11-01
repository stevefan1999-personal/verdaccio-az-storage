import { RestError } from '@azure/storage-blob';
import { describe, expect, test } from 'vitest';
import { AppConfigLocalStorageProvider, KEY_VALUE_LIMIT_BYTES, type LocalStorage } from '../src/localStorage';
import { MemoryAppConfiguration } from './fakes';

const KEY = 'verdaccio-db';
const SECRET = 'b'.repeat(32);
const DOCUMENT: LocalStorage = { list: ['pkg'], secret: SECRET };

// A database whose key-value (key, value and content type) is exactly `bytes` long.
function databaseOfSize(bytes: number): LocalStorage {
  const overhead = [KEY, JSON.stringify({ list: [''], secret: SECRET }), 'application/json'].join('').length;
  return { list: ['p'.repeat(bytes - overhead)], secret: SECRET };
}

function providerWith(value?: string, keyName = KEY) {
  const store = new MemoryAppConfiguration();
  const etag = value === undefined ? undefined : store.seed(keyName, value);
  return { store, etag, provider: new AppConfigLocalStorageProvider(store, keyName) };
}

describe('AppConfigLocalStorageProvider.read', () => {
  test('returns the document with its ETag', async () => {
    const { provider, etag } = providerWith(JSON.stringify(DOCUMENT));
    await expect(provider.read()).resolves.toEqual({ kind: 'present', document: DOCUMENT, etag });
  });

  test('reads the configured key', async () => {
    const { provider, store } = providerWith(JSON.stringify(DOCUMENT), 'custom-key');
    await expect(provider.read()).resolves.toMatchObject({ kind: 'present' });
    expect(store.getConfigurationSetting).toHaveBeenCalledWith({ key: 'custom-key' });
  });

  test('a 404 reads as missing', async () => {
    await expect(providerWith().provider.read()).resolves.toEqual({ kind: 'missing' });
  });

  test.each([
    [
      'a network error without a status (1.x read it as missing)',
      new RestError('getaddrinfo ENOTFOUND', { code: 'REQUEST_SEND_ERROR' }),
      503,
    ],
    ['401', new RestError('Unauthorized', { statusCode: 401 }), 500],
    ['403', new RestError('Forbidden', { statusCode: 403 }), 500],
    ['500', new RestError('Internal Server Error', { statusCode: 500 }), 503],
  ])('%s rejects', async (_case, error, code) => {
    const { provider, store } = providerWith();
    store.getConfigurationSetting.mockRejectedValueOnce(error);
    await expect(provider.read()).rejects.toMatchObject({ code });
  });

  test.each([
    ['an empty value', { value: '', etag: 'etag-1' }],
    ['no value', { etag: 'etag-1' }],
    ['no ETag', { value: JSON.stringify(DOCUMENT) }],
  ])('%s rejects instead of reading as missing', async (_case, setting) => {
    const { provider, store } = providerWith();
    store.getConfigurationSetting.mockResolvedValueOnce(setting);
    await expect(provider.read()).rejects.toMatchObject({ code: 500 });
  });

  test('invalid JSON rejects without quoting the value, which V8 would do', async () => {
    const { provider } = providerWith(`{"secret":${SECRET}}`);
    await expect(provider.read()).rejects.toMatchObject({
      code: 500,
      message: 'the verdaccio database is not valid JSON',
    });
  });
});

describe('AppConfigLocalStorageProvider.write', () => {
  test('adds the key, which is create-only, when it was missing', async () => {
    const { provider, store } = providerWith();
    await expect(provider.write(DOCUMENT, { kind: 'missing' })).resolves.toBe('written');
    expect(store.addConfigurationSetting).toHaveBeenCalledWith({
      key: KEY,
      value: JSON.stringify(DOCUMENT),
      contentType: 'application/json',
    });
    expect(store.settings.get(KEY)?.value).toBe(JSON.stringify(DOCUMENT));
  });

  test('a create that finds the key is a conflict', async () => {
    const { provider } = providerWith(JSON.stringify(DOCUMENT));
    await expect(provider.write(DOCUMENT, { kind: 'missing' })).resolves.toBe('conflict');
  });

  test('replaces the key only while its ETag still matches', async () => {
    const { provider, store, etag } = providerWith(JSON.stringify(DOCUMENT));
    const previous = await provider.read();
    await expect(provider.write({ ...DOCUMENT, list: [] }, previous)).resolves.toBe('written');
    expect(store.setConfigurationSetting).toHaveBeenCalledWith(
      { key: KEY, value: JSON.stringify({ ...DOCUMENT, list: [] }), contentType: 'application/json', etag },
      { onlyIfUnchanged: true },
    );
    await expect(provider.write(DOCUMENT, previous)).resolves.toBe('conflict');
  });

  test('writes a key-value of exactly 10 KB', async () => {
    const { provider, store } = providerWith();
    await expect(provider.write(databaseOfSize(KEY_VALUE_LIMIT_BYTES), { kind: 'missing' })).resolves.toBe('written');
    expect(store.settings.get(KEY)?.value).toBe(JSON.stringify(databaseOfSize(KEY_VALUE_LIMIT_BYTES)));
  });

  test('refuses a key-value over 10 KB with its size, and sends nothing', async () => {
    const { provider, store } = providerWith(JSON.stringify(DOCUMENT));
    const previous = await provider.read();
    await expect(provider.write(databaseOfSize(KEY_VALUE_LIMIT_BYTES + 1), previous)).rejects.toMatchObject({
      code: 500,
      message: `the verdaccio database needs ${KEY_VALUE_LIMIT_BYTES + 1} bytes, over the ${KEY_VALUE_LIMIT_BYTES} bytes of one App Configuration key-value`,
    });
    expect(store.setConfigurationSetting).not.toHaveBeenCalled();
    expect(store.settings.get(KEY)?.value).toBe(JSON.stringify(DOCUMENT));
  });

  test('other failures reject', async () => {
    const { provider, store } = providerWith();
    store.addConfigurationSetting.mockRejectedValueOnce(new RestError('Forbidden', { statusCode: 403 }));
    await expect(provider.write(DOCUMENT, { kind: 'missing' })).rejects.toMatchObject({ code: 500 });
  });
});
