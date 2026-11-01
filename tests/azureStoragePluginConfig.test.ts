import { describe, expect, test } from 'vitest';
import { parseAzureStorageConfig } from '../src/azureStoragePluginConfig';
import { AZURITE_CONNECTION_STRING } from './fakes';

const NO_ENVIRONMENT: NodeJS.ProcessEnv = {};
const CONNECTION_STRING_SECTION = { connectionString: AZURITE_CONNECTION_STRING, containerName: 'verdaccio' };

function failureOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the action to fail');
}

describe('parseAzureStorageConfig', () => {
  test('uses the connection string method and the defaults when the file names only the required keys', () => {
    expect(parseAzureStorageConfig(CONNECTION_STRING_SECTION, NO_ENVIRONMENT)).toEqual({
      authMethod: 'ConnectionString',
      connectionString: AZURITE_CONNECTION_STRING,
      containerName: 'verdaccio',
      packagesDir: 'packages',
      appConfigKeyName: 'verdaccio-db',
    });
  });

  test.each([
    ['authMethod', 'AZ_STORAGE_AUTH_METHOD', 'ConnectionString'],
    ['connectionString', 'AZ_STORAGE_CONNECTION_STRING', 'UseDevelopmentStorage=true'],
    ['containerName', 'AZ_STORAGE_CONTAINER_NAME', 'from-environment'],
    [
      'appConfigConnectionString',
      'AZ_STORAGE_APP_CONFIG_CONNECTION_STRING',
      'Endpoint=https://a.azconfig.io;Id=i;Secret=s',
    ],
  ])('%s from %s overrides the file', (key, variable, value) => {
    const config = parseAzureStorageConfig(
      { ...CONNECTION_STRING_SECTION, appConfigConnectionString: 'Endpoint=https://file.azconfig.io;Id=i;Secret=s' },
      { [variable]: value },
    );
    expect(config).toMatchObject({ [key]: value });
  });

  test.each([
    ['accountName', 'AZ_STORAGE_ACCOUNT_NAME', 'environmentaccount'],
    ['accountKey', 'AZ_STORAGE_ACCOUNT_KEY', 'environment-key'],
    ['accountDomain', 'AZ_STORAGE_ACCOUNT_DOMAIN', 'blob.core.chinacloudapi.cn'],
  ])('%s from %s overrides the file', (key, variable, value) => {
    const section = {
      authMethod: 'StorageSharedKeyCredential',
      accountName: 'fileaccount',
      accountKey: 'file-key',
      accountDomain: 'blob.core.windows.net',
      containerName: 'verdaccio',
    };
    expect(parseAzureStorageConfig(section, { [variable]: value })).toMatchObject({ [key]: value });
  });

  test('an empty environment variable falls back to the file', () => {
    const config = parseAzureStorageConfig(CONNECTION_STRING_SECTION, {
      AZ_STORAGE_CONNECTION_STRING: '',
      AZ_STORAGE_CONTAINER_NAME: '',
    });
    expect(config).toMatchObject(CONNECTION_STRING_SECTION);
  });

  test('the environment alone can configure the plugin', () => {
    const config = parseAzureStorageConfig(
      {},
      {
        AZ_STORAGE_AUTH_METHOD: 'DefaultAzureCredential',
        AZ_STORAGE_ACCOUNT_NAME: 'account',
        AZ_STORAGE_CONTAINER_NAME: 'verdaccio',
      },
    );
    expect(config).toMatchObject({ authMethod: 'DefaultAzureCredential', accountName: 'account' });
  });

  test('keys of the other methods are dropped', () => {
    const config = parseAzureStorageConfig({ ...CONNECTION_STRING_SECTION, accountKey: 'unused-key' }, NO_ENVIRONMENT);
    expect(config).not.toHaveProperty('accountKey');
  });

  test.each([
    ['ConnectionString', {}, 'connectionString'],
    ['StorageSharedKeyCredential', { accountName: 'account' }, 'accountKey'],
    ['StorageSharedKeyCredential', { accountKey: 'key' }, 'accountName'],
    ['DefaultAzureCredential', {}, 'accountName'],
  ])('%s requires %o to have %s', (authMethod, keys, missingKey) => {
    expect(() => parseAzureStorageConfig({ authMethod, containerName: 'verdaccio', ...keys }, NO_ENVIRONMENT)).toThrow(
      `at ${missingKey}`,
    );
  });

  test('every method requires containerName', () => {
    expect(() => parseAzureStorageConfig({ connectionString: AZURITE_CONNECTION_STRING }, NO_ENVIRONMENT)).toThrow(
      'at containerName',
    );
  });

  test('an unknown method is rejected', () => {
    expect(() =>
      parseAzureStorageConfig({ ...CONNECTION_STRING_SECTION, authMethod: 'Anonymous' }, NO_ENVIRONMENT),
    ).toThrow('Azure Storage Plugin: invalid store.az-storage configuration');
  });

  test('a section that is not an object is rejected', () => {
    expect(() => parseAzureStorageConfig(null, NO_ENVIRONMENT)).toThrow('invalid store.az-storage configuration');
  });

  test('the empty values of the README example mean "not set"', () => {
    const config = parseAzureStorageConfig(
      {
        connectionString: null,
        containerName: 'example',
        packagesDir: 'packages',
        cachePackageDataTime: null,
        cachePackageTime: null,
        appConfigConnectionString: null,
        appConfigKeyName: 'verdaccio-db',
      },
      { AZ_STORAGE_CONNECTION_STRING: AZURITE_CONNECTION_STRING },
    );
    expect(config).toEqual({
      authMethod: 'ConnectionString',
      connectionString: AZURITE_CONNECTION_STRING,
      containerName: 'example',
      packagesDir: 'packages',
      appConfigKeyName: 'verdaccio-db',
    });
  });

  test('cache times may be numeric strings, and 0 is kept as "no header"', () => {
    const config = parseAzureStorageConfig(
      { ...CONNECTION_STRING_SECTION, cachePackageDataTime: '300', cachePackageTime: 0 },
      NO_ENVIRONMENT,
    );
    expect(config).toMatchObject({ cachePackageDataTime: 300, cachePackageTime: 0 });
  });

  test.each([-1, 1.5, 'soon'])('cache time %o is rejected', (cachePackageTime) => {
    expect(() => parseAzureStorageConfig({ ...CONNECTION_STRING_SECTION, cachePackageTime }, NO_ENVIRONMENT)).toThrow(
      'at cachePackageTime',
    );
  });

  test.each(['../registry', '..', 'packages/../..', '/packages'])(
    'packagesDir %o, which is absolute or leaves the container, is rejected',
    (packagesDir) => {
      expect(() => parseAzureStorageConfig({ ...CONNECTION_STRING_SECTION, packagesDir }, NO_ENVIRONMENT)).toThrow(
        'packagesDir must be a relative folder inside the container',
      );
    },
  );

  test.each(['./packages', 'nested/packages/', 'old/../packages', '.'])(
    'packagesDir %o stays inside the container, so it is accepted as 1.x accepted it',
    (packagesDir) => {
      expect(parseAzureStorageConfig({ ...CONNECTION_STRING_SECTION, packagesDir }, NO_ENVIRONMENT)).toMatchObject({
        packagesDir,
      });
    },
  );

  test('the plugin section and the whole merged configuration parse the same', () => {
    const merged = {
      storage: './storage',
      configPath: '/etc/verdaccio/config.yaml',
      store: { 'az-storage': CONNECTION_STRING_SECTION },
      packages: { '**': { access: '$all' } },
      ...CONNECTION_STRING_SECTION,
    };
    expect(parseAzureStorageConfig(merged, NO_ENVIRONMENT)).toEqual(
      parseAzureStorageConfig(CONNECTION_STRING_SECTION, NO_ENVIRONMENT),
    );
  });

  test('the error never repeats a connection string or an account key', () => {
    const attempts = [
      { authMethod: 'Anonymous', connectionString: 'AccountKey=connection-secret' },
      { authMethod: 'StorageSharedKeyCredential', accountKey: 'account-secret', containerName: 'verdaccio' },
      { authMethod: 'ConnectionString', connectionString: 'AccountKey=connection-secret', cachePackageTime: 'x' },
    ];
    for (const section of attempts) {
      expect(failureOf(() => parseAzureStorageConfig(section, NO_ENVIRONMENT))).not.toMatch(
        /connection-secret|account-secret/,
      );
    }
  });
});
