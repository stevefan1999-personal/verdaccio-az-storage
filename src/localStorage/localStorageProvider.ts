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

// Loose, so that keys this version does not know survive a rewrite; the database keeps the 1.x shape.
// Compiled, because every call parses its document again, and Verdaccio reads the tokens on every
// request that carries a generated token.
export const LocalStorageSchema = z.compile(z.looseObject({ list: z.array(z.string()), secret: z.string() }), {
  strict: true,
});
export const TokenDocumentSchema = z.compile(z.looseObject({ tokens: z.array(TokenSchema) }), { strict: true });

export type LocalStorage = z.infer<typeof LocalStorageSchema>;
export type TokenDocument = z.infer<typeof TokenDocumentSchema>;
export type StoredLocalStorage = StoredDocument<LocalStorage>;
export type WriteOutcome = 'written' | 'conflict';

/** Where one document of the Verdaccio database lives. */
export interface ILocalStorageProvider<Document> {
  /** Missing only when the backend answered "not found"; every other failure rejects. */
  read(): Promise<StoredDocument<Document>>;
  /** Create-only when `previous` was missing, If-Match on its ETag otherwise; a lost race is a conflict. */
  write(next: Document, previous: StoredDocument<Document>): Promise<WriteOutcome>;
}

export function parseLocalStorage(text: string): LocalStorage {
  return parseJsonDocument(text, LocalStorageSchema, 'the verdaccio database');
}

export function parseTokenDocument(text: string): TokenDocument {
  return parseJsonDocument(text, TokenDocumentSchema, 'the verdaccio tokens');
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
