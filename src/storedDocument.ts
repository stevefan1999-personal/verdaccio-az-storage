import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import type {
  BlobDownloadOptions,
  BlobDownloadResponseParsed,
  BlockBlobParallelUploadOptions,
  BlockBlobUploadStreamOptions,
} from '@azure/storage-blob';
import { errorUtils } from '@verdaccio/core';
import * as z from 'zod';
import { isBlobNotFound, toVerdaccioError } from './azureErrors';

/** The BlockBlobClient calls this plugin makes. The SDK client satisfies it, and the unit tests fake it. */
export interface PluginBlob {
  download(
    offset?: number,
    count?: number,
    options?: BlobDownloadOptions,
  ): Promise<Pick<BlobDownloadResponseParsed, 'contentLength' | 'etag' | 'readableStreamBody'>>;
  uploadData(data: Buffer, options?: BlockBlobParallelUploadOptions): Promise<unknown>;
  uploadStream(
    stream: Readable,
    bufferSize?: number,
    maxConcurrency?: number,
    options?: BlockBlobUploadStreamOptions,
  ): Promise<unknown>;
  exists(): Promise<boolean>;
  deleteIfExists(): Promise<unknown>;
}

/** The ContainerClient call this plugin makes. */
export interface PluginContainer {
  getBlockBlobClient(blobName: string): PluginBlob;
}

export type StoredDocument<Document> = { kind: 'missing' } | { kind: 'present'; document: Document; etag: string };

/** Parses a stored JSON document. The messages never quote the text, because the database holds the secret. */
export function parseJsonDocument<Document>(text: string, schema: z.ZodType<Document>, description: string): Document {
  const result = schema.safeParse(parseJson(text, description));
  if (result.success) {
    return result.data;
  }
  throw errorUtils.getInternalError(
    `${description} does not have the expected shape\n${z.prettifyError(result.error)}`,
  );
}

function parseJson(text: string, description: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // V8 quotes the input in its SyntaxError message.
    throw errorUtils.getInternalError(`${description} is not valid JSON`);
  }
}

/**
 * Downloads and parses a JSON blob in one GET, with the ETag that a conditional write needs.
 * Only a definite BlobNotFound reads as missing; every other failure rejects.
 */
export async function readBlobDocument<Document>(
  blob: PluginBlob,
  parse: (text: string) => Document,
): Promise<StoredDocument<Document>> {
  try {
    const { etag, readableStreamBody } = await blob.download();
    if (etag === undefined || readableStreamBody === undefined) {
      throw errorUtils.getInternalError('azure answered a download without a body or an etag');
    }
    return { kind: 'present', document: parse(await text(readableStreamBody)), etag };
  } catch (error) {
    if (isBlobNotFound(error)) {
      return { kind: 'missing' };
    }
    throw toVerdaccioError(error);
  }
}
