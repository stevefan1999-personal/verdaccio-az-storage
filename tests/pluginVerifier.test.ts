import { verifyPlugin } from '@verdaccio/plugin-verifier';
import { beforeEach, describe, expect, test } from 'vitest';
import { AZURITE_ACCOUNT_NAME, AZURITE_CONNECTION_STRING, clearAzureEnvironment } from './fakes';

// Loads the built lib/ through the package's self-link in node_modules, as Verdaccio would.
describe('plugin verifier', () => {
  beforeEach(clearAzureEnvironment);

  test.each([
    ['a connection string', { connectionString: AZURITE_CONNECTION_STRING, containerName: 'verdaccio' }],
    [
      'DefaultAzureCredential',
      { authMethod: 'DefaultAzureCredential', accountName: AZURITE_ACCOUNT_NAME, containerName: 'verdaccio' },
    ],
  ])('loads the plugin as a storage plugin configured with %s', async (_case, pluginConfig) => {
    const result = await verifyPlugin({ pluginPath: 'az-storage', category: 'storage', pluginConfig });
    expect(result).toMatchObject({ success: true, pluginsLoaded: 1 });
  });
});
