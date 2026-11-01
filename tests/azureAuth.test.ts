import { DefaultAzureCredential } from '@azure/identity';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { describe, expect, test } from 'vitest';
import { createContainerClient } from '../src/azureAuth';
import { parseAzureStorageConfig } from '../src/azureStoragePluginConfig';
import { AZURITE_ACCOUNT_NAME, AZURITE_CONNECTION_STRING } from './fakes';

function containerFor(section: Record<string, unknown>): ContainerClient {
  const container = createContainerClient(parseAzureStorageConfig(section, {}));
  if (!(container instanceof ContainerClient)) {
    throw new Error('expected an Azure SDK ContainerClient');
  }
  return container;
}

describe('createContainerClient', () => {
  test('a connection string addresses its blob endpoint with the shared key it contains', () => {
    const container = containerFor({ connectionString: AZURITE_CONNECTION_STRING, containerName: 'verdaccio' });
    expect(container.url).toBe(`http://127.0.0.1:10000/${AZURITE_ACCOUNT_NAME}/verdaccio`);
    expect(container.credential).toBeInstanceOf(StorageSharedKeyCredential);
  });

  test('an account name and key use a shared key credential on the default domain', () => {
    const container = containerFor({
      authMethod: 'StorageSharedKeyCredential',
      accountName: 'account',
      accountKey: Buffer.from('key').toString('base64'),
      containerName: 'verdaccio',
    });
    expect(container.url).toBe('https://account.blob.core.windows.net/verdaccio');
    expect(container.credential).toBeInstanceOf(StorageSharedKeyCredential);
  });

  test('DefaultAzureCredential uses the account name and a custom domain', () => {
    const container = containerFor({
      authMethod: 'DefaultAzureCredential',
      accountName: 'account',
      accountDomain: 'blob.core.chinacloudapi.cn',
      containerName: 'verdaccio',
    });
    expect(container.url).toBe('https://account.blob.core.chinacloudapi.cn/verdaccio');
    expect(container.credential).toBeInstanceOf(DefaultAzureCredential);
  });
});
