import { errorUtils, pluginUtils, type searchUtils } from '@verdaccio/core';
import type { Logger, Token, TokenFilter } from '@verdaccio/types';
import * as z from 'zod';
import { createAppConfigurationStore, createContainerClient } from './azureAuth';
import AzureStoragePackageManager from './azureStoragePackageManager';
import { type AzureStorageConfig, parseAzureStorageConfig } from './azureStoragePluginConfig';
import { LOGGER_PREFIX } from './constants';
import {
  AppConfigLocalStorageProvider,
  type ILocalStorageProvider,
  LocalStorageDatabase,
  StorageBlobLocalStorageProvider,
  TokenSchema,
} from './localStorage';
import { PackageUpdates } from './packageUpdates';
import type { PluginContainer } from './storedDocument';

const DATABASE_BLOB_NAME = '.verdaccio-db.json';
const SEARCH_SCORE: searchUtils.Score = { final: 1, detail: { quality: 1, popularity: 1, maintenance: 0 } };

function createDatabaseProvider(config: AzureStorageConfig, container: PluginContainer): ILocalStorageProvider {
  return config.appConfigConnectionString === undefined
    ? new StorageBlobLocalStorageProvider(container.getBlockBlobClient(DATABASE_BLOB_NAME))
    : new AppConfigLocalStorageProvider(
        createAppConfigurationStore(config.appConfigConnectionString),
        config.appConfigKeyName,
      );
}

const isSameToken = (token: Pick<Token, 'user' | 'key'>, user: string, key: string): boolean =>
  token.user === user && token.key === key;

/**
 * Verdaccio 7 storage plugin. The methods use the promise contract (`get()` takes no callback),
 * so Verdaccio does not wrap the plugin in its fail-open legacy adapter.
 */
export class AzureStoragePlugin
  extends pluginUtils.Plugin<AzureStorageConfig>
  implements pluginUtils.Storage<AzureStorageConfig>
{
  readonly logger: Logger;
  private readonly settings: AzureStorageConfig;
  private readonly container: PluginContainer;
  private readonly database: LocalStorageDatabase;
  // Shared by every handler, because the store saves a manifest through a new handler.
  private readonly packageUpdates = new PackageUpdates();

  /** `config` is the plugin section, or the whole configuration merged with it. No I/O happens here. */
  constructor(config: unknown, options: pluginUtils.PluginOptions) {
    const settings = parseAzureStorageConfig(config, process.env);
    super(settings, options);
    this.settings = settings;
    this.logger = options.logger;
    this.container = createContainerClient(settings);
    this.database = new LocalStorageDatabase(createDatabaseProvider(settings, this.container));
    this.logger.info(
      {
        containerName: settings.containerName,
        database: settings.appConfigConnectionString === undefined ? DATABASE_BLOB_NAME : 'App Configuration',
      },
      `${LOGGER_PREFIX}: container @{containerName}, verdaccio database in @{database}`,
    );
  }

  /** Reads the database once, so a database that cannot be read stops Verdaccio before it serves. */
  async init(): Promise<void> {
    await this.database.read();
  }

  async getSecret(): Promise<string> {
    return (await this.database.read()).secret;
  }

  setSecret(secret: string): Promise<void> {
    return this.database.update((current) => {
      if (current.secret === secret) {
        return current;
      }
      // Two first starts raced with different generated secrets; a restart reads the stored one.
      if (current.secret !== '') {
        throw errorUtils.getConflict('a different verdaccio secret is already stored');
      }
      return { ...current, secret };
    });
  }

  async get(): Promise<string[]> {
    return (await this.database.read()).list;
  }

  add(packageName: string): Promise<void> {
    return this.database.update((current) =>
      current.list.includes(packageName) ? current : { ...current, list: [...current.list, packageName] },
    );
  }

  remove(packageName: string): Promise<void> {
    return this.database.update((current) => ({
      ...current,
      list: current.list.filter((listed) => listed !== packageName),
    }));
  }

  /** Private packages only, as in 1.x; the store reads each manifest itself. */
  async search(query: searchUtils.SearchQuery): Promise<searchUtils.SearchItem[]> {
    return (await this.get())
      .filter((packageName) => packageName.includes(query.text))
      .map((packageName) => ({
        package: { name: packageName },
        verdaccioPrivate: true,
        verdaccioPkgCached: false,
        score: SEARCH_SCORE,
      }));
  }

  getPackageStorage(packageName: string): pluginUtils.StorageHandler {
    return new AzureStoragePackageManager(packageName, this.settings, this.logger, this.container, this.packageUpdates);
  }

  /** Upserts by user and key. Tokens live next to the secret, which encrypts the two-factor records. */
  async saveToken(token: Token): Promise<void> {
    // Validated before it is stored: a record the read schema rejects would make the database unreadable.
    const parsed = TokenSchema.safeParse(token);
    if (!parsed.success) {
      throw errorUtils.getBadData(`the token cannot be stored\n${z.prettifyError(parsed.error)}`);
    }
    await this.database.update((current) => ({
      ...current,
      tokens: [...current.tokens.filter((existing) => !isSameToken(existing, token.user, token.key)), parsed.data],
    }));
  }

  deleteToken(user: string, tokenKey: string): Promise<void> {
    return this.database.update((current) => ({
      ...current,
      tokens: current.tokens.filter((existing) => !isSameToken(existing, user, tokenKey)),
    }));
  }

  async readTokens({ user }: TokenFilter): Promise<Token[]> {
    return (await this.database.read()).tokens.filter((token) => token.user === user);
  }
}
