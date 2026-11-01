import { isDeepStrictEqual } from 'node:util';
import { errorUtils } from '@verdaccio/core';
import { KeyedQueue } from '../packageUpdates';
import type { StoredDocument } from '../storedDocument';
import type { ILocalStorageProvider } from './localStorageProvider';

export const DATABASE_WRITE_ATTEMPTS = 3;
const MUTATION_QUEUE_KEY = 'database';

/**
 * One document of the Verdaccio database (the package list and secret, or the tokens) without a cache:
 * every call reads the backend, so a second writer or a restart never works from stale data.
 */
export class LocalStorageDatabase<Document> {
  private readonly provider: ILocalStorageProvider<Document>;
  private readonly empty: Document;
  private readonly mutations = new KeyedQueue();

  constructor(provider: ILocalStorageProvider<Document>, empty: Document) {
    this.provider = provider;
    this.empty = empty;
  }

  /** A missing document reads as empty without being written. */
  async read(): Promise<Document> {
    return this.contentOf(await this.provider.read());
  }

  update(change: (current: Document) => Document): Promise<void> {
    return this.mutations.run(MUTATION_QUEUE_KEY, () => this.apply(change, DATABASE_WRITE_ATTEMPTS));
  }

  // A new copy each time, as a parsed document is, so a caller that changes what it read changes nothing else.
  private contentOf(stored: StoredDocument<Document>): Document {
    return stored.kind === 'present' ? stored.document : structuredClone(this.empty);
  }

  // Each attempt reads again, so a write that lost a race applies the change to the winner's document.
  private async apply(change: (current: Document) => Document, attemptsLeft: number): Promise<void> {
    const stored = await this.provider.read();
    const current = this.contentOf(stored);
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
