import { type PluginBlob, readBlobDocument, type StoredDocument } from '../../storedDocument';
import { type ILocalStorageProvider, type WriteOutcome, writeOutcome } from '../localStorageProvider';

/** Keeps one database document in a JSON blob at the container root. */
export class StorageBlobLocalStorageProvider<Document> implements ILocalStorageProvider<Document> {
  private readonly blob: PluginBlob;
  private readonly parse: (text: string) => Document;

  constructor(blob: PluginBlob, parse: (text: string) => Document) {
    this.blob = blob;
    this.parse = parse;
  }

  read(): Promise<StoredDocument<Document>> {
    return readBlobDocument(this.blob, this.parse);
  }

  write(next: Document, previous: StoredDocument<Document>): Promise<WriteOutcome> {
    // One Put Blob: a reader sees the old document or the new one, never a mix.
    return writeOutcome(
      this.blob.uploadData(Buffer.from(JSON.stringify(next)), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        conditions: previous.kind === 'missing' ? { ifNoneMatch: '*' } : { ifMatch: previous.etag },
      }),
    );
  }
}
