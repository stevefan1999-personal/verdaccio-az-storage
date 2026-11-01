import { errorUtils, HTTP_STATUS } from '@verdaccio/core';
import * as z from 'zod';

const PRECONDITION_FAILED = 412;
const TOO_MANY_REQUESTS = 429;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([HTTP_STATUS.REQUEST_TIMEOUT, TOO_MANY_REQUESTS]);
const CONCURRENT_WRITE = 'the blob changed while it was being written, retry the request';

// Read RestError fields structurally: `instanceof RestError` fails across the duplicated
// @azure/core-rest-pipeline copies that the Azure packages install.
const AzureErrorSchema = z
  .object({
    name: z.string().optional().catch(undefined),
    statusCode: z.number().optional().catch(undefined),
    code: z.string().optional().catch(undefined),
    details: z
      .object({ errorCode: z.string().optional().catch(undefined) })
      .optional()
      .catch(undefined),
  })
  .catch({});

const VerdaccioErrorSchema = z.object({ status: z.number(), code: z.number() });

type AzureFailure = { name?: string; statusCode?: number; errorCode?: string };

function readFailure(error: unknown): AzureFailure {
  const { name, statusCode, code, details } = AzureErrorSchema.parse(error);
  // HEAD responses have no body, so their error code arrives only in details (x-ms-error-code).
  return { name, statusCode, errorCode: details?.errorCode ?? code };
}

/** A definite "this blob does not exist". A missing container or any other 404 is not. */
export function isBlobNotFound(error: unknown): boolean {
  const { statusCode, errorCode } = readFailure(error);
  return statusCode === HTTP_STATUS.NOT_FOUND && errorCode === 'BlobNotFound';
}

/** A response with this HTTP status, such as App Configuration's 404 for a key that does not exist. */
export function hasStatus(error: unknown, statusCode: number): boolean {
  return readFailure(error).statusCode === statusCode;
}

/** A conditional write lost: If-Match did not match, or If-None-Match: * found an existing blob. */
export function isWriteConflict(error: unknown): boolean {
  const { statusCode, errorCode } = readFailure(error);
  return (
    statusCode === PRECONDITION_FAILED || (statusCode === HTTP_STATUS.CONFLICT && errorCode === 'BlobAlreadyExists')
  );
}

function isPassThrough(error: unknown): error is Error {
  return error instanceof Error && (error.name === 'AbortError' || VerdaccioErrorSchema.safeParse(error).success);
}

/**
 * Maps an Azure failure to the Verdaccio error the store understands. Only BlobNotFound becomes 404,
 * because the store treats 404 as "missing" and falls back to the uplink. The message carries only the
 * status and the error code, so it never repeats a connection string, a key or a raw identity error.
 */
export function toVerdaccioError(error: unknown): Error {
  if (isPassThrough(error)) {
    return error;
  }
  if (isBlobNotFound(error)) {
    return errorUtils.getNotFound();
  }
  if (isWriteConflict(error)) {
    return errorUtils.getConflict(CONCURRENT_WRITE);
  }
  const { name, statusCode, errorCode } = readFailure(error);
  const reason = `azure request failed: ${statusCode ?? 'no response'} ${errorCode ?? name ?? 'unknown error'}`;
  const retryable =
    statusCode === undefined || RETRYABLE_STATUSES.has(statusCode) || statusCode >= HTTP_STATUS.INTERNAL_ERROR;
  return retryable ? errorUtils.getServiceUnavailable(reason) : errorUtils.getInternalError(reason);
}

/** Rejects with {@link toVerdaccioError} of the Azure failure. */
export function withVerdaccioErrors<T>(operation: Promise<T>): Promise<T> {
  return operation.catch((error: unknown) => {
    throw toVerdaccioError(error);
  });
}
