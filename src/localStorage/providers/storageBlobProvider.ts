import { type PluginBlob, readBlobDocument } from '../../storedDocument';
import {
  type ILocalStorageProvider,
  type LocalStorage,
  parseLocalStorage,
  type StoredLocalStorage,
  type WriteOutcome,
  writeOutcome,
} from '../localStorageProvider';

/** Keeps the database in `.verdaccio-db.json` at the container root. */
export class StorageBlobLocalStorageProvider implements ILocalStorageProvider {
  private readonly blob: PluginBlob;

  constructor(blob: PluginBlob) {
    this.blob = blob;
  }

  read(): Promise<StoredLocalStorage> {
    return readBlobDocument(this.blob, parseLocalStorage);
  }

  write(next: LocalStorage, previous: StoredLocalStorage): Promise<WriteOutcome> {
    // One Put Blob: a reader sees the old document or the new one, never a mix.
    return writeOutcome(
      this.blob.uploadData(Buffer.from(JSON.stringify(next)), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: previous.kind === 'missing' ? { ifNoneMatch: '*' } : { ifMatch: previous.etag },
      }),
    );
  }
}
