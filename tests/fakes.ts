import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import {
  type BlobDownloadOptions,
  type BlobHTTPHeaders,
  type BlobRequestConditions,
  type BlockBlobParallelUploadOptions,
  type BlockBlobUploadStreamOptions,
  RestError,
} from '@azure/storage-blob';
import type { Config, Logger } from '@verdaccio/types';
import { vi } from 'vitest';
import type { AppConfigurationStore } from '../src/localStorage';
import type { PluginBlob, PluginContainer } from '../src/storedDocument';

/** The published Azurite development key: it opens only the local emulator. */
export const AZURITE_ACCOUNT_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
export const AZURITE_ACCOUNT_NAME = 'devstoreaccount1';
export const AZURITE_CONNECTION_STRING = `DefaultEndpointsProtocol=http;AccountName=${AZURITE_ACCOUNT_NAME};AccountKey=${AZURITE_ACCOUNT_KEY};BlobEndpoint=http://127.0.0.1:10000/${AZURITE_ACCOUNT_NAME}`;

const AZURE_ENVIRONMENT_VARIABLES = [
  'AZ_STORAGE_AUTH_METHOD',
  'AZ_STORAGE_CONNECTION_STRING',
  'AZ_STORAGE_ACCOUNT_NAME',
  'AZ_STORAGE_ACCOUNT_KEY',
  'AZ_STORAGE_ACCOUNT_DOMAIN',
  'AZ_STORAGE_CONTAINER_NAME',
  'AZ_STORAGE_APP_CONFIG_CONNECTION_STRING',
];

/** Keeps a developer's own AZ_STORAGE_* variables out of the tests; `unstubEnvs` restores them. */
export function clearAzureEnvironment(): void {
  for (const variable of AZURE_ENVIRONMENT_VARIABLES) {
    vi.stubEnv(variable, undefined);
  }
}

/** The smallest Verdaccio configuration that satisfies the type; the plugin only passes it on. */
export function fakeVerdaccioConfig(): Config {
  return {
    server_id: 'unit-tests',
    secret: '',
    configPath: '/etc/verdaccio/config.yaml',
    packages: {},
    uplinks: {},
    security: { web: { sign: {}, verify: {} }, api: { legacy: false } },
    checkSecretKey: (secret) => secret || '',
    getMatchedPackagesSpec: () => undefined,
  };
}

export function fakeLogger(): Logger {
  return {
    child: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    error: vi.fn(),
    http: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
}

/** A RestError shaped like the Azure answer. A HEAD answer has no body, so only details carries its code. */
export function azureError(statusCode: number | undefined, errorCode?: string, { head = false } = {}): RestError {
  const error = new RestError(`test failure ${statusCode} ${errorCode}`, {
    statusCode,
    code: head ? undefined : errorCode,
  });
  error.details = errorCode === undefined ? undefined : { errorCode };
  return error;
}

export function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

type StoredBlob = { content: Buffer; etag: string; headers?: BlobHTTPHeaders };

/** One container in memory, with the conditional-write answers that Azure and Azurite give. */
export class MemoryContainer implements PluginContainer {
  readonly blobs = new Map<string, StoredBlob>();
  private readonly clients = new Map<string, MemoryBlob>();
  private version = 0;

  getBlockBlobClient(blobName: string): MemoryBlob {
    const client = this.clients.get(blobName) ?? new MemoryBlob(this, blobName);
    this.clients.set(blobName, client);
    return client;
  }

  seed(blobName: string, content: string): string {
    const etag = this.nextEtag();
    this.blobs.set(blobName, { content: Buffer.from(content), etag });
    return etag;
  }

  textOf(blobName: string): string | undefined {
    return this.blobs.get(blobName)?.content.toString('utf8');
  }

  put(blobName: string, content: Buffer, conditions: BlobRequestConditions = {}, headers?: BlobHTTPHeaders): void {
    const stored = this.blobs.get(blobName);
    if (conditions.ifNoneMatch === '*' && stored !== undefined) {
      throw azureError(409, 'BlobAlreadyExists');
    }
    if (conditions.ifMatch !== undefined && stored?.etag !== conditions.ifMatch) {
      throw azureError(412, 'ConditionNotMet');
    }
    this.blobs.set(blobName, { content, etag: this.nextEtag(), headers });
  }

  private nextEtag(): string {
    this.version += 1;
    return `"0x${this.version.toString(16).padStart(15, '0')}"`;
  }
}

/** A blob client of {@link MemoryContainer}. Every call answers after an I/O turn, as a real request does. */
export class MemoryBlob implements PluginBlob {
  private readonly container: MemoryContainer;
  private readonly name: string;

  constructor(container: MemoryContainer, name: string) {
    this.container = container;
    this.name = name;
  }

  readonly download = vi.fn(async (_offset?: number, _count?: number, options?: BlobDownloadOptions) => {
    await setImmediate();
    if (options?.abortSignal?.aborted) {
      throw abortError();
    }
    const stored = this.container.blobs.get(this.name);
    if (stored === undefined) {
      throw azureError(404, 'BlobNotFound');
    }
    return {
      etag: stored.etag,
      contentLength: stored.content.length,
      readableStreamBody: Readable.from([stored.content]),
    };
  });

  readonly uploadData = vi.fn(async (data: Buffer, options?: BlockBlobParallelUploadOptions) => {
    await setImmediate();
    this.container.put(this.name, data, options?.conditions, options?.blobHTTPHeaders);
  });

  // Like the SDK's BufferScheduler: it listens to data, end and error only, so a source destroyed
  // without an error leaves the upload pending, and nothing is committed before the source ends.
  readonly uploadStream = vi.fn(
    (stream: Readable, _bufferSize?: number, _maxConcurrency?: number, options?: BlockBlobUploadStreamOptions) =>
      new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () =>
          setImmediate()
            .then(() =>
              this.container.put(this.name, Buffer.concat(chunks), options?.conditions, options?.blobHTTPHeaders),
            )
            .then(resolve, reject),
        );
      }),
  );

  readonly exists = vi.fn(async () => {
    await setImmediate();
    return this.container.blobs.has(this.name);
  });

  readonly deleteIfExists = vi.fn(async () => {
    await setImmediate();
    return { succeeded: this.container.blobs.delete(this.name) };
  });
}

type AddSetting = Parameters<AppConfigurationStore['addConfigurationSetting']>[0];
type SetSetting = Parameters<AppConfigurationStore['setConfigurationSetting']>[0];

/** App Configuration in memory, with its 404 for a missing key and 412 for a lost conditional write. */
export class MemoryAppConfiguration implements AppConfigurationStore {
  readonly settings = new Map<string, { value: string; etag: string; contentType: string }>();
  private version = 0;

  readonly getConfigurationSetting = vi.fn(
    async ({ key }: { key: string }): Promise<{ value?: string; etag?: string }> => {
      await setImmediate();
      const setting = this.settings.get(key);
      if (setting === undefined) {
        throw new RestError('Not Found', { statusCode: 404 });
      }
      return setting;
    },
  );

  readonly addConfigurationSetting = vi.fn(async (setting: AddSetting) => {
    await setImmediate();
    if (this.settings.has(setting.key)) {
      throw new RestError('Status 412: Setting was already present', { statusCode: 412 });
    }
    this.store(setting);
  });

  readonly setConfigurationSetting = vi.fn(async (setting: SetSetting, options: { onlyIfUnchanged: boolean }) => {
    await setImmediate();
    if (options.onlyIfUnchanged && this.settings.get(setting.key)?.etag !== setting.etag) {
      throw new RestError('Precondition Failed', { statusCode: 412 });
    }
    this.store(setting);
  });

  seed(key: string, value: string): string {
    return this.store({ key, value, contentType: 'application/json' });
  }

  private store({ key, value, contentType }: AddSetting): string {
    this.version += 1;
    const etag = `etag-${this.version}`;
    this.settings.set(key, { value, etag, contentType });
    return etag;
  }
}
