import { errorUtils, HTTP_STATUS } from '@verdaccio/core';
import { hasStatus, toVerdaccioError } from '../../azureErrors';
import {
  type ILocalStorageProvider,
  type LocalStorage,
  parseLocalStorage,
  type StoredLocalStorage,
  type WriteOutcome,
  writeOutcome,
} from '../localStorageProvider';

type JsonSetting = { key: string; value: string; contentType: string };

// App Configuration refuses a key-value over 10 KB, counting the key, the value and its attributes.
export const KEY_VALUE_LIMIT_BYTES = 10 * 1024;

/** The AppConfigurationClient calls this provider makes. The SDK client satisfies it, and the unit tests fake it. */
export interface AppConfigurationStore {
  getConfigurationSetting(id: { key: string }): Promise<{ value?: string; etag?: string }>;
  addConfigurationSetting(setting: JsonSetting): Promise<unknown>;
  setConfigurationSetting(
    setting: JsonSetting & { etag: string },
    options: { onlyIfUnchanged: boolean },
  ): Promise<unknown>;
}

/** Keeps the database in one Azure App Configuration key-value. */
export class AppConfigLocalStorageProvider implements ILocalStorageProvider<LocalStorage> {
  private readonly client: AppConfigurationStore;
  private readonly keyName: string;

  constructor(client: AppConfigurationStore, keyName: string) {
    this.client = client;
    this.keyName = keyName;
  }

  async read(): Promise<StoredLocalStorage> {
    try {
      const { value, etag } = await this.client.getConfigurationSetting({ key: this.keyName });
      // 1.x read an empty value as "missing" and then wrote an empty database over the key.
      if (!value || etag === undefined) {
        throw errorUtils.getInternalError('the verdaccio database in App Configuration has no value or no etag');
      }
      return { kind: 'present', document: parseLocalStorage(value), etag };
    } catch (error) {
      if (hasStatus(error, HTTP_STATUS.NOT_FOUND)) {
        return { kind: 'missing' };
      }
      throw toVerdaccioError(error);
    }
  }

  async write(next: LocalStorage, previous: StoredLocalStorage): Promise<WriteOutcome> {
    const setting = { key: this.keyName, value: JSON.stringify(next), contentType: 'application/json' };
    const size = Object.values(setting).reduce((total, text) => total + Buffer.byteLength(text), 0);
    // Refused here with the size, because the refusal of the service reaches the client only as a status code.
    if (size > KEY_VALUE_LIMIT_BYTES) {
      throw errorUtils.getInternalError(
        `the verdaccio database needs ${size} bytes, over the ${KEY_VALUE_LIMIT_BYTES} bytes of one App Configuration key-value`,
      );
    }
    // addConfigurationSetting sends If-None-Match: *, and onlyIfUnchanged sends If-Match with the read ETag.
    return writeOutcome(
      previous.kind === 'missing'
        ? this.client.addConfigurationSetting(setting)
        : this.client.setConfigurationSetting({ ...setting, etag: previous.etag }, { onlyIfUnchanged: true }),
    );
  }
}
