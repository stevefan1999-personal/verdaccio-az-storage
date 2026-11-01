import { RestError } from '@azure/storage-blob';
import type { Manifest, Token } from '@verdaccio/types';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createAppConfigurationStore, createContainerClient } from '../src/azureAuth';
import { AzureStoragePlugin } from '../src/azureStoragePlugin';
import {
  AZURITE_CONNECTION_STRING,
  azureError,
  clearAzureEnvironment,
  fakeLogger,
  fakeVerdaccioConfig,
  MemoryAppConfiguration,
  MemoryContainer,
} from './fakes';

vi.mock('../src/azureAuth', () => ({ createContainerClient: vi.fn(), createAppConfigurationStore: vi.fn() }));

const DATABASE = '.verdaccio-db.json';
const SECRET = 'c'.repeat(32);
const SECTION = { connectionString: AZURITE_CONNECTION_STRING, containerName: 'verdaccio' };
const APP_CONFIG_CONNECTION_STRING = 'Endpoint=https://store.azconfig.io;Id=id;Secret=c2VjcmV0';

function setup(section: Record<string, unknown> = SECTION, container = new MemoryContainer()) {
  const appConfiguration = new MemoryAppConfiguration();
  vi.mocked(createContainerClient).mockReturnValue(container);
  vi.mocked(createAppConfigurationStore).mockReturnValue(appConfiguration);
  const plugin = new AzureStoragePlugin(section, { config: fakeVerdaccioConfig(), logger: fakeLogger() });
  return { plugin, container, appConfiguration, databaseBlob: container.getBlockBlobClient(DATABASE) };
}

const storedDatabase = (container: MemoryContainer): unknown => JSON.parse(container.textOf(DATABASE) ?? 'null');

function tokenOf(user: string, key: string, extra: Partial<Token> = {}): Token {
  return { user, key, token: 'masked', readonly: false, created: 1_700_000_000_000, ...extra };
}

beforeEach(clearAzureEnvironment);

describe('construction', () => {
  test('creates the clients from the parsed configuration without any request', () => {
    const { databaseBlob } = setup();
    expect(createContainerClient).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: 'ConnectionString', containerName: 'verdaccio' }),
    );
    expect(createAppConfigurationStore).not.toHaveBeenCalled();
    expect(databaseBlob.download).not.toHaveBeenCalled();
    expect(databaseBlob.uploadData).not.toHaveBeenCalled();
  });

  test('reads the AZ_STORAGE_* environment variables', () => {
    vi.stubEnv('AZ_STORAGE_CONTAINER_NAME', 'from-environment');
    setup();
    expect(createContainerClient).toHaveBeenCalledWith(expect.objectContaining({ containerName: 'from-environment' }));
  });

  test('throws for an invalid configuration', () => {
    expect(() => setup({ containerName: 'verdaccio' })).toThrow('at connectionString');
  });

  test('get() and add(name) take no callback, so Verdaccio 7 does not wrap the plugin in its legacy adapter', () => {
    const { plugin } = setup();
    expect(plugin.get.length).toBe(0);
    expect(plugin.add.length).toBe(1);
  });

  test('extends the Verdaccio plugin base class', () => {
    expect(setup().plugin.getVersion()).toBe(1);
  });
});

describe('database location', () => {
  test('without appConfigConnectionString the database is the blob at the container root', async () => {
    const { plugin, container } = setup();
    await plugin.add('pkg');
    expect(storedDatabase(container)).toEqual({ list: ['pkg'], secret: '', tokens: [] });
  });

  test('with appConfigConnectionString the database is the configured App Configuration key', async () => {
    const { plugin, container, appConfiguration } = setup({
      ...SECTION,
      appConfigConnectionString: APP_CONFIG_CONNECTION_STRING,
      appConfigKeyName: 'custom-key',
    });
    await plugin.add('pkg');
    expect(createAppConfigurationStore).toHaveBeenCalledWith(APP_CONFIG_CONNECTION_STRING);
    expect(JSON.parse(appConfiguration.settings.get('custom-key')?.value ?? 'null')).toMatchObject({ list: ['pkg'] });
    expect(container.blobs.size).toBe(0);
  });
});

describe('init', () => {
  test('resolves for a missing database without creating it', async () => {
    const { plugin, container } = setup();
    await plugin.init();
    expect(container.blobs.size).toBe(0);
  });

  test.each([
    ['AuthorizationFailure', azureError(403, 'AuthorizationFailure')],
    ['ContainerNotFound', azureError(404, 'ContainerNotFound')],
    ['no response', new RestError('connect ECONNREFUSED', { code: 'REQUEST_SEND_ERROR' })],
  ])('rejects when the read fails with %s, and writes nothing', async (_case, error) => {
    const { plugin, databaseBlob } = setup();
    databaseBlob.download.mockRejectedValueOnce(error);
    await expect(plugin.init()).rejects.toMatchObject({ code: expect.any(Number) });
    expect(databaseBlob.uploadData).not.toHaveBeenCalled();
  });

  test('rejects for a database that is not valid JSON, and leaves it as it is', async () => {
    const { plugin, container } = setup();
    container.seed(DATABASE, '{"list":');
    await expect(plugin.init()).rejects.toMatchObject({ code: 500 });
    expect(container.textOf(DATABASE)).toBe('{"list":');
  });

  test('rejects when App Configuration fails without a status, which 1.x read as "missing"', async () => {
    const { plugin, appConfiguration } = setup({ ...SECTION, appConfigConnectionString: APP_CONFIG_CONNECTION_STRING });
    appConfiguration.getConfigurationSetting.mockRejectedValueOnce(
      new RestError('getaddrinfo ENOTFOUND store.azconfig.io', { code: 'REQUEST_SEND_ERROR' }),
    );
    await expect(plugin.init()).rejects.toMatchObject({ code: 503 });
    expect(appConfiguration.addConfigurationSetting).not.toHaveBeenCalled();
  });
});

describe('secret', () => {
  test('a missing database has an empty secret', async () => {
    await expect(setup().plugin.getSecret()).resolves.toBe('');
  });

  test('setSecret stores the first secret and keeps the package list', async () => {
    const { plugin, container } = setup();
    container.seed(DATABASE, JSON.stringify({ list: ['pkg'], secret: '' }));
    await plugin.setSecret(SECRET);
    expect(storedDatabase(container)).toEqual({ list: ['pkg'], secret: SECRET, tokens: [] });
  });

  test('setSecret with the stored secret does not write', async () => {
    const { plugin, container, databaseBlob } = setup();
    container.seed(DATABASE, JSON.stringify({ list: [], secret: SECRET }));
    await plugin.setSecret(SECRET);
    expect(databaseBlob.uploadData).not.toHaveBeenCalled();
  });

  test('setSecret with a different secret rejects with 409 and keeps the stored one', async () => {
    const { plugin, container } = setup();
    container.seed(DATABASE, JSON.stringify({ list: [], secret: SECRET }));
    await expect(plugin.setSecret('d'.repeat(32))).rejects.toMatchObject({ code: 409 });
    expect(storedDatabase(container)).toMatchObject({ secret: SECRET });
  });

  test('only the first start writes the secret Verdaccio generated', async () => {
    const container = new MemoryContainer();
    // What Verdaccio's storage does at startup: setSecret(checkSecretKey(await getSecret())).
    const start = async (generated: string) => {
      const { plugin } = setup(SECTION, container);
      await plugin.init();
      const stored = await plugin.getSecret();
      await plugin.setSecret(stored === '' ? generated : stored);
    };
    await start(SECRET);
    await start('e'.repeat(32));
    expect(storedDatabase(container)).toMatchObject({ secret: SECRET });
    expect(container.getBlockBlobClient(DATABASE).uploadData).toHaveBeenCalledTimes(1);
  });
});

describe('package list', () => {
  test('add lists a package once', async () => {
    const { plugin, databaseBlob } = setup();
    await plugin.add('pkg');
    await plugin.add('pkg');
    await expect(plugin.get()).resolves.toEqual(['pkg']);
    expect(databaseBlob.uploadData).toHaveBeenCalledTimes(1);
  });

  test('remove unlists a package, and removing an absent one writes nothing', async () => {
    const { plugin, databaseBlob } = setup();
    await plugin.add('first');
    await plugin.add('second');
    await plugin.remove('first');
    await plugin.remove('absent');
    await expect(plugin.get()).resolves.toEqual(['second']);
    expect(databaseBlob.uploadData).toHaveBeenCalledTimes(3);
  });

  test('every read sees what another process wrote', async () => {
    const container = new MemoryContainer();
    const first = setup(SECTION, container).plugin;
    const second = setup(SECTION, container).plugin;
    await first.add('pkg');
    await expect(second.get()).resolves.toEqual(['pkg']);
  });

  test('add rejects without writing when the database cannot be read', async () => {
    const { plugin, databaseBlob } = setup();
    databaseBlob.download.mockRejectedValueOnce(azureError(503, 'ServerBusy'));
    await expect(plugin.add('pkg')).rejects.toMatchObject({ code: 503 });
    expect(databaseBlob.uploadData).not.toHaveBeenCalled();
  });
});

describe('search', () => {
  test('returns the listed packages whose name contains the text, as private packages', async () => {
    const { plugin } = setup();
    await plugin.add('@scope/match-one');
    await plugin.add('other');
    await plugin.add('match-two');
    const results = await plugin.search({ text: 'match', quality: 1, popularity: 1, maintenance: 1 });
    expect(results).toEqual([
      expect.objectContaining({
        package: { name: '@scope/match-one' },
        verdaccioPrivate: true,
        verdaccioPkgCached: false,
      }),
      expect.objectContaining({
        package: { name: 'match-two' },
        score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 0 } },
      }),
    ]);
  });
});

describe('tokens', () => {
  test('saveToken stores a token, and readTokens returns the tokens of one user', async () => {
    const { plugin, container } = setup();
    await plugin.saveToken(tokenOf('alice', 'key-1', { cidr: ['10.0.0.0/8'] }));
    await plugin.saveToken(tokenOf('bob', 'key-2'));
    await expect(plugin.readTokens({ user: 'alice' })).resolves.toEqual([
      tokenOf('alice', 'key-1', { cidr: ['10.0.0.0/8'] }),
    ]);
    expect(storedDatabase(container)).toMatchObject({ tokens: [{ user: 'alice' }, { user: 'bob' }] });
  });

  test('saveToken replaces the token with the same user and key', async () => {
    const { plugin } = setup();
    await plugin.saveToken(tokenOf('alice', 'tfa:config', { token: 'first' }));
    await plugin.saveToken(tokenOf('alice', 'tfa:config', { token: 'second' }));
    await expect(plugin.readTokens({ user: 'alice' })).resolves.toEqual([
      tokenOf('alice', 'tfa:config', { token: 'second' }),
    ]);
  });

  test('deleteToken removes one token and ignores one that is absent', async () => {
    const { plugin } = setup();
    await plugin.saveToken(tokenOf('alice', 'key-1'));
    await plugin.saveToken(tokenOf('alice', 'key-2'));
    await plugin.deleteToken('alice', 'key-1');
    await plugin.deleteToken('nobody', 'key-1');
    await expect(plugin.readTokens({ user: 'alice' })).resolves.toEqual([tokenOf('alice', 'key-2')]);
  });

  test('a token the database could not read back is refused with 422 and not stored', async () => {
    const { plugin, databaseBlob } = setup();
    // The API checks that cidr_whitelist is an array, not what it holds.
    const unreadable = tokenOf('alice', 'key-1');
    Reflect.set(unreadable, 'cidr', [42]);
    await expect(plugin.saveToken(unreadable)).rejects.toMatchObject({ code: 422 });
    expect(databaseBlob.uploadData).not.toHaveBeenCalled();
  });
});

describe('getPackageStorage', () => {
  test('every handler shares the update locks, so a save from a new handler carries If-Match', async () => {
    const { plugin, container } = setup();
    const manifest: Manifest = {
      name: 'pkg',
      'dist-tags': {},
      time: {},
      versions: {},
      _attachments: {},
      _distfiles: {},
      _uplinks: {},
      _rev: '1-a',
    };
    const etag = container.seed('packages/pkg/package.json', JSON.stringify(manifest));
    await plugin.getPackageStorage('pkg').updatePackage('pkg', async (current) => {
      await plugin.getPackageStorage('pkg').savePackage('pkg', current);
      return current;
    });
    expect(container.getBlockBlobClient('packages/pkg/package.json').uploadData).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ conditions: { ifMatch: etag } }),
    );
  });
});
