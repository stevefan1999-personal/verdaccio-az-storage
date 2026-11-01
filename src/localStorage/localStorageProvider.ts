import * as z from 'zod';
import { isWriteConflict, toVerdaccioError } from '../azureErrors';
import { parseJsonDocument, type StoredDocument } from '../storedDocument';

const timestamp = z.union([z.number(), z.string()]);

/** A Verdaccio token record: npm tokens, web login sessions and two-factor records. */
export const TokenSchema = z.looseObject({
  user: z.string(),
  token: z.string(),
  key: z.string(),
  cidr: z.array(z.string()).optional(),
  readonly: z.boolean(),
  created: timestamp,
  updated: timestamp.optional(),
});

// Loose, so that keys this version does not know survive a rewrite. 1.x documents have no tokens.
// Compiled, because every token-authenticated request reads the database.
export const LocalStorageSchema = z.compile(
  z.looseObject({ list: z.array(z.string()), secret: z.string(), tokens: z.array(TokenSchema).default([]) }),
  { strict: true },
);

export type LocalStorage = z.infer<typeof LocalStorageSchema>;
export type StoredLocalStorage = StoredDocument<LocalStorage>;
export type WriteOutcome = 'written' | 'conflict';

/** Where the Verdaccio database document lives. */
export interface ILocalStorageProvider {
  /** Missing only when the backend answered "not found"; every other failure rejects. */
  read(): Promise<StoredLocalStorage>;
  /** Create-only when `previous` was missing, If-Match on its ETag otherwise; a lost race is a conflict. */
  write(next: LocalStorage, previous: StoredLocalStorage): Promise<WriteOutcome>;
}

export function parseLocalStorage(text: string): LocalStorage {
  return parseJsonDocument(text, LocalStorageSchema, 'the verdaccio database');
}

export function writeOutcome(write: Promise<unknown>): Promise<WriteOutcome> {
  return write.then(
    () => 'written' as const,
    (error: unknown) => {
      if (isWriteConflict(error)) {
        return 'conflict' as const;
      }
      throw toVerdaccioError(error);
    },
  );
}
