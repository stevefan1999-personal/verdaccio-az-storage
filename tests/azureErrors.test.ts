import { CredentialUnavailableError } from '@azure/identity';
import { RestError } from '@azure/storage-blob';
import { errorUtils } from '@verdaccio/core';
import { describe, expect, test } from 'vitest';
import { hasStatus, isBlobNotFound, isWriteConflict, toVerdaccioError, withVerdaccioErrors } from '../src/azureErrors';
import { abortError, azureError } from './fakes';

describe('toVerdaccioError', () => {
  test('a BlobNotFound download becomes 404, the code the store answers from the uplink', () => {
    expect(toVerdaccioError(azureError(404, 'BlobNotFound'))).toMatchObject({ code: 404, status: 404 });
  });

  test('a BlobNotFound HEAD answer, which has the error code only in details, becomes 404', () => {
    expect(toVerdaccioError(azureError(404, 'BlobNotFound', { head: true }))).toMatchObject({ code: 404 });
  });

  test.each([
    ['ContainerNotFound', 'ContainerNotFound'],
    ['a 404 without an error code', undefined],
  ])('%s becomes 500 and never reads as a missing blob', (_case, errorCode) => {
    const error = toVerdaccioError(azureError(404, errorCode));
    expect(error).toMatchObject({ code: 500 });
    expect(error.message).toBe(`azure request failed: 404 ${errorCode ?? 'RestError'}`);
  });

  test.each([
    [412, 'ConditionNotMet'],
    [409, 'BlobAlreadyExists'],
  ])('a lost conditional write (%i %s) becomes 409', (statusCode, errorCode) => {
    expect(toVerdaccioError(azureError(statusCode, errorCode))).toMatchObject({ code: 409 });
  });

  test('another 409 becomes 500', () => {
    expect(toVerdaccioError(azureError(409, 'LeaseIdMissing'))).toMatchObject({ code: 500 });
  });

  test.each([
    [408, 'OperationTimedOut'],
    [429, 'TooManyRequests'],
    [500, 'InternalError'],
    [503, 'ServerBusy'],
  ])('a transient %i %s becomes 503', (statusCode, errorCode) => {
    const error = toVerdaccioError(azureError(statusCode, errorCode));
    expect(error).toMatchObject({ code: 503 });
    expect(error.message).toBe(`azure request failed: ${statusCode} ${errorCode}`);
  });

  test('a request that got no response becomes 503', () => {
    const error = toVerdaccioError(
      new RestError('connect ECONNREFUSED 127.0.0.1:10000', { code: 'REQUEST_SEND_ERROR' }),
    );
    expect(error).toMatchObject({ code: 503, message: 'azure request failed: no response REQUEST_SEND_ERROR' });
  });

  test.each([
    [401, 'NoAuthenticationInformation'],
    [403, 'AuthenticationFailed'],
    [403, 'AuthorizationFailure'],
    [403, 'AuthorizationPermissionMismatch'],
    [400, 'InvalidHeaderValue'],
  ])('%i %s becomes 500', (statusCode, errorCode) => {
    expect(toVerdaccioError(azureError(statusCode, errorCode))).toMatchObject({ code: 500 });
  });

  test('an identity error becomes 503 and names its type, not its message', () => {
    const error = toVerdaccioError(
      new CredentialUnavailableError('EnvironmentCredential is unavailable: client-secret'),
    );
    expect(error).toMatchObject({ code: 503, message: 'azure request failed: no response CredentialUnavailableError' });
  });

  test('a value that is not an error becomes 503', () => {
    expect(toVerdaccioError('a string')).toMatchObject({
      code: 503,
      message: 'azure request failed: no response unknown error',
    });
  });

  test('a Verdaccio error passes through unchanged', () => {
    const error = errorUtils.getBadData('bad');
    expect(toVerdaccioError(error)).toBe(error);
  });

  test('an AbortError passes through unchanged, so stream cancellation keeps its meaning', () => {
    const error = abortError();
    expect(toVerdaccioError(error)).toBe(error);
  });

  test('the message never repeats the original message', () => {
    const error = toVerdaccioError(
      new RestError('AccountKey=secret-key', { statusCode: 403, code: 'AuthorizationFailure' }),
    );
    expect(error.message).not.toContain('secret-key');
  });
});

describe('error predicates', () => {
  test('isBlobNotFound accepts BlobNotFound only', () => {
    expect(isBlobNotFound(azureError(404, 'BlobNotFound'))).toBe(true);
    expect(isBlobNotFound(azureError(404, 'BlobNotFound', { head: true }))).toBe(true);
    expect(isBlobNotFound(azureError(404, 'ContainerNotFound'))).toBe(false);
    expect(isBlobNotFound(errorUtils.getNotFound())).toBe(false);
    expect(isBlobNotFound(undefined)).toBe(false);
  });

  test('isWriteConflict accepts 412 and 409 BlobAlreadyExists', () => {
    expect(isWriteConflict(azureError(412, 'ConditionNotMet'))).toBe(true);
    expect(isWriteConflict(new RestError('Status 412: Setting was already present', { statusCode: 412 }))).toBe(true);
    expect(isWriteConflict(azureError(409, 'BlobAlreadyExists'))).toBe(true);
    expect(isWriteConflict(azureError(409, 'LeaseIdMissing'))).toBe(false);
    expect(isWriteConflict(azureError(503, 'ServerBusy'))).toBe(false);
  });

  test('hasStatus reads the HTTP status', () => {
    expect(hasStatus(new RestError('Not Found', { statusCode: 404 }), 404)).toBe(true);
    expect(hasStatus(new RestError('no response', { code: 'REQUEST_SEND_ERROR' }), 404)).toBe(false);
  });
});

describe('withVerdaccioErrors', () => {
  test('resolves with the value of the operation', async () => {
    await expect(withVerdaccioErrors(Promise.resolve(true))).resolves.toBe(true);
  });

  test('rejects with the mapped error', async () => {
    await expect(withVerdaccioErrors(Promise.reject(azureError(404, 'BlobNotFound')))).rejects.toMatchObject({
      code: 404,
    });
  });
});
