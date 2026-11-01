import { AppConfigurationClient } from '@azure/app-configuration';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { AzureStorageConfig } from './azureStoragePluginConfig';
import type { AppConfigurationStore } from './localStorage';
import type { PluginContainer } from './storedDocument';

const accountUrl = ({ accountName, accountDomain }: { accountName: string; accountDomain: string }): string =>
  `https://${accountName}.${accountDomain}`;

function createServiceClient(config: AzureStorageConfig): BlobServiceClient {
  switch (config.authMethod) {
    case 'ConnectionString':
      return BlobServiceClient.fromConnectionString(config.connectionString);
    case 'StorageSharedKeyCredential':
      return new BlobServiceClient(
        accountUrl(config),
        new StorageSharedKeyCredential(config.accountName, config.accountKey),
      );
    case 'DefaultAzureCredential':
      return new BlobServiceClient(accountUrl(config), new DefaultAzureCredential());
  }
}

/** Creates the container client. Construction does no I/O; credentials are only used by the first request. */
export function createContainerClient(config: AzureStorageConfig): PluginContainer {
  return createServiceClient(config).getContainerClient(config.containerName);
}

/** Creates the App Configuration client that keeps the database when `appConfigConnectionString` is set. */
export function createAppConfigurationStore(connectionString: string): AppConfigurationStore {
  return new AppConfigurationClient(connectionString);
}
