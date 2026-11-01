import { isDeepStrictEqual } from 'node:util';
import { errorUtils } from '@verdaccio/core';
import { KeyedQueue } from '../packageUpdates';
import type { ILocalStorageProvider, LocalStorage, StoredLocalStorage } from './localStorageProvider';

export const DATABASE_WRITE_ATTEMPTS = 3;
const MUTATION_QUEUE_KEY = 'database';

const contentOf = (stored: StoredLocalStorage): LocalStorage =>
  stored.kind === 'present' ? stored.document : { list: [], secret: '', tokens: [] };

/**
 * The Verdaccio database (private package list, secret and tokens) without a cache: every call reads
 * the backend, so a second writer or a restart never works from stale data.
 */
export class LocalStorageDatabase {
  private readonly provider: ILocalStorageProvider;
  private readonly mutations = new KeyedQueue();

  constructor(provider: ILocalStorageProvider) {
    this.provider = provider;
  }

  /** A missing document reads as empty without being written. */
  async read(): Promise<LocalStorage> {
    return contentOf(await this.provider.read());
  }

  update(change: (current: LocalStorage) => LocalStorage): Promise<void> {
    return this.mutations.run(MUTATION_QUEUE_KEY, () => this.apply(change, DATABASE_WRITE_ATTEMPTS));
  }

  // Each attempt reads again, so a write that lost a race applies the change to the winner's document.
  private async apply(change: (current: LocalStorage) => LocalStorage, attemptsLeft: number): Promise<void> {
    const stored = await this.provider.read();
    const current = contentOf(stored);
    const next = change(current);
    if (isDeepStrictEqual(current, next) || (await this.provider.write(next, stored)) === 'written') {
      return;
    }
    if (attemptsLeft > 1) {
      return this.apply(change, attemptsLeft - 1);
    }
    throw errorUtils.getConflict('the verdaccio database changed during every write attempt, retry the request');
  }
}
