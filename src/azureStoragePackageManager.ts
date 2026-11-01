import { posix } from 'node:path';
import { addAbortSignal, PassThrough, pipeline, type Readable, type Stream, Writable } from 'node:stream';
import type { BlobHTTPHeaders, BlobRequestConditions } from '@azure/storage-blob';
import { errorUtils, HEADER_TYPE, type pluginUtils } from '@verdaccio/core';
import type { Logger, Manifest } from '@verdaccio/types';
import * as z from 'zod';
import { toVerdaccioError, withVerdaccioErrors } from './azureErrors';
import type { AzureStorageConfig } from './azureStoragePluginConfig';
import { LOGGER_PREFIX } from './constants';
import type { PackageUpdates } from './packageUpdates';
import { type PluginBlob, type PluginContainer, parseJsonDocument, readBlobDocument } from './storedDocument';

const MANIFEST_FILE_NAME = 'package.json';
const MANIFEST_CONTENT_TYPE = 'application/json';
const TARBALL_CONTENT_TYPE = 'application/x-compressed-tar';
const UNSAFE_SEGMENTS: ReadonlySet<string> = new Set(['', '.', '..']);

// The store also keeps documents that are not manifests here (the stage index), so only an object is required.
const ManifestSchema = z.custom<Manifest>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'expected a JSON object',
);

const parseManifest = (text: string): Manifest => parseJsonDocument(text, ManifestSchema, 'package metadata');

const httpHeaders = (blobContentType: string, cacheSeconds: number | undefined): BlobHTTPHeaders =>
  cacheSeconds ? { blobContentType, blobCacheControl: `public, max-age=${cacheSeconds}` } : { blobContentType };

/** One package: `<packagesDir>/<name>/package.json` and its tarballs, the same layout as 1.x. */
export default class AzureStoragePackageManager implements pluginUtils.StorageHandler {
  readonly logger: Logger;
  private readonly packageName: string;
  private readonly config: AzureStorageConfig;
  private readonly container: PluginContainer;
  private readonly updates: PackageUpdates;
  private readonly manifestBlobName: string;

  constructor(
    packageName: string,
    config: AzureStorageConfig,
    logger: Logger,
    container: PluginContainer,
    updates: PackageUpdates,
  ) {
    this.packageName = packageName;
    this.config = config;
    this.logger = logger;
    this.container = container;
    this.updates = updates;
    this.manifestBlobName = this.blobName(MANIFEST_FILE_NAME);
  }

  async readPackage(): Promise<Manifest> {
    return (await this.readManifest()).document;
  }

  hasPackage(): Promise<boolean> {
    return withVerdaccioErrors(this.blob(MANIFEST_FILE_NAME).exists());
  }

  createPackage(_packageName: string, manifest: Manifest): Promise<void> {
    // If-None-Match: * makes the second of two concurrent creates fail instead of replacing the first.
    return this.saveManifest(manifest, { ifNoneMatch: '*' });
  }

  savePackage(_packageName: string, manifest: Manifest): Promise<void> {
    return this.saveManifest(manifest, this.updates.conditionsFor(this.manifestBlobName));
  }

  updatePackage(_packageName: string, handleUpdate: (manifest: Manifest) => Promise<Manifest>): Promise<Manifest> {
    // The store saves inside handleUpdate, so the save carries If-Match with the ETag read here.
    // A 412 becomes a 409 without a retry: the store's update callbacks are not safe to run twice.
    return this.updates.update(this.manifestBlobName, () => this.readManifest(), handleUpdate);
  }

  async deletePackage(fileName: string): Promise<void> {
    // Idempotent, so an unpublish that failed halfway can be retried.
    await withVerdaccioErrors(this.blob(fileName).deleteIfExists());
  }

  async removePackage(): Promise<void> {
    // A container has no folders: the package is gone once its blobs are deleted.
  }

  hasTarball(fileName: string): Promise<boolean> {
    return withVerdaccioErrors(this.blob(fileName).exists());
  }

  async readTarball(fileName: string, { signal }: { signal: AbortSignal }): Promise<Readable> {
    const blob = this.blob(fileName);
    const tarball = this.observed(fileName, addAbortSignal(signal, new PassThrough()));
    blob
      .download(0, undefined, { abortSignal: signal })
      .then(({ contentLength, readableStreamBody }) => {
        if (readableStreamBody === undefined) {
          throw errorUtils.getInternalError('azure answered a tarball download without a body');
        }
        // The store copies content-length into the response headers only while they are unsent.
        if (contentLength !== undefined) {
          tarball.emit(HEADER_TYPE.CONTENT_LENGTH, contentLength);
        }
        tarball.emit('open');
        // pipeline destroys the tarball with a body error as it is: mapping it to 404 here would make the
        // store refetch from the uplink into a response that already sent data.
        pipeline(readableStreamBody, tarball, () => undefined);
      })
      // A missing blob arrives as an error event with code 404, which the store answers from the uplink.
      .catch((error: unknown) => tarball.destroy(toVerdaccioError(error)));
    return tarball;
  }

  async writeTarball(fileName: string, { signal }: { signal: AbortSignal }): Promise<Writable> {
    const blob = this.blob(fileName);
    const source = this.observed(fileName, new PassThrough());
    // uploadStream stages blocks and commits the block list only after the source ends, so a reader
    // never sees a partial tarball and a cancelled upload leaves no blob.
    const commit = blob.uploadStream(source, undefined, undefined, {
      abortSignal: signal,
      blobHTTPHeaders: httpHeaders(TARBALL_CONTENT_TYPE, this.config.cachePackageTime),
    });
    const tarball: Writable = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (source.write(chunk)) {
          callback();
        } else {
          source.once('drain', () => callback());
        }
      },
      final(callback) {
        source.end();
        // 'finish', and so the store's metadata update, waits for the committed blob.
        commit.then(
          () => callback(),
          (error: unknown) => callback(toVerdaccioError(error)),
        );
      },
      destroy(error, callback) {
        // uploadStream never settles when its source closes without an error, so a cancel always passes one.
        if (!tarball.writableFinished) {
          source.destroy(error ?? errorUtils.getInternalError('tarball upload cancelled'));
        }
        callback(error);
      },
    });
    // A failed block upload pauses the source, so a write waiting for 'drain' would wait forever.
    commit.catch((error: unknown) => tarball.destroy(toVerdaccioError(error)));
    return this.observed(fileName, addAbortSignal(signal, tarball));
  }

  // A stream can error before anyone listens to it (an aborted signal, a failed request, or the upload
  // source after its upload failed), and an 'error' event without a listener would end the process.
  private observed<Tarball extends Stream>(fileName: string, tarball: Tarball): Tarball {
    tarball.on('error', (error: Error) => {
      this.logger.debug(
        { fileName, error: error.message },
        `${LOGGER_PREFIX}: tarball stream @{fileName} failed: @{error}`,
      );
    });
    return tarball;
  }

  private async readManifest(): Promise<{ document: Manifest; etag: string }> {
    const stored = await readBlobDocument(this.blob(MANIFEST_FILE_NAME), parseManifest);
    if (stored.kind === 'missing') {
      throw errorUtils.getNotFound();
    }
    return stored;
  }

  private async saveManifest(manifest: Manifest, conditions: BlobRequestConditions): Promise<void> {
    await withVerdaccioErrors(
      this.blob(MANIFEST_FILE_NAME).uploadData(Buffer.from(JSON.stringify(manifest)), {
        blobHTTPHeaders: httpHeaders(MANIFEST_CONTENT_TYPE, this.config.cachePackageDataTime),
        conditions,
      }),
    );
  }

  private blob(fileName: string): PluginBlob {
    return this.container.getBlockBlobClient(this.blobName(fileName));
  }

  private blobName(fileName: string): string {
    const relativeName = `${this.packageName}/${fileName}`;
    // Verdaccio validates names before they reach storage. This keeps one that slipped through from
    // escaping packagesDir, where it could reach the database blob at the container root.
    if (relativeName.split('/').some((segment) => UNSAFE_SEGMENTS.has(segment))) {
      throw errorUtils.getInternalError('the package or file name is not a safe blob name');
    }
    return posix.join(this.config.packagesDir, relativeName);
  }
}
