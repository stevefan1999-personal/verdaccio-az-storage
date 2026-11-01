import { join } from 'node:path';
import type { ContainerClient } from '@azure/storage-blob';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as z from 'zod';
import {
  type AzureStore,
  Azurite,
  addUser,
  azuriteConnectionString,
  CreatedToken,
  DATABASE_BLOB,
  freePort,
  ListedTokens,
  Npm,
  readBlob,
  readDatabase,
  readStoredDocuments,
  readTokens,
  type StoredBlob,
  startReadDenyingProxy,
  Teardown,
  TOKENS_BLOB,
  Verdaccio,
  writePackage,
} from './harness';

const CONTAINER = 'verdaccio';
const USER = 'e2e-owner';
const PASSWORD = 'e2e-owner-password';
const PACKAGE = 'e2e-az-kept';
const VERSION = '1.0.0';

const teardown = new Teardown();
let directory: string;
let location: string;
let azurite: Azurite;
let container: ContainerClient;
let store: AzureStore;
let port: number;
let npm: Npm;
let apiToken: string;
let storedDocuments: StoredBlob[];

const startVerdaccio = async () => teardown.add(await Verdaccio.start(join(directory, CONTAINER), store, { port }));

// These starts must fail. One that does not is stopped at once, so it cannot hold the port for the next test.
async function failedStart(containerName: string, connectionString = store.connectionString) {
  const launch = await Verdaccio.launch(join(directory, containerName), { connectionString, containerName }, { port });
  if (launch.kind === 'exited') {
    return launch;
  }
  await launch.verdaccio.stop();
  return { kind: launch.kind, log: launch.verdaccio.log() };
}

describe('Verdaccio start-up when the database cannot be read', () => {
  // A database with a package, a secret and a token, on an Azurite that keeps its data on disk.
  beforeAll(async () => {
    directory = await teardown.temporaryDirectory('safety');
    location = join(directory, 'azurite');
    azurite = teardown.add(await Azurite.start({ location }));
    container = azurite.container(CONTAINER);
    await container.create();
    store = { connectionString: azurite.connectionString, containerName: CONTAINER };
    port = await freePort();
    const verdaccio = await startVerdaccio();
    const sessionToken = await addUser(verdaccio.url, USER, PASSWORD);
    npm = await Npm.create(join(directory, 'owner'), verdaccio.url, sessionToken, { npm_config_password: PASSWORD });
    await npm.exec(['publish'], await writePackage(directory, PACKAGE, VERSION));
    apiToken = (await npm.json(['token', 'create'], CreatedToken)).token;
    await verdaccio.stop();
    storedDocuments = await readStoredDocuments(container);
  });

  afterAll(() => teardown.run());

  test.each([DATABASE_BLOB, TOKENS_BLOB])(
    'refuses to start when reads of %s are denied, and leaves it as it was',
    async (deniedBlob) => {
      const proxy = teardown.add(await startReadDenyingProxy(azurite.port, deniedBlob));
      expect(await failedStart(CONTAINER, azuriteConnectionString(proxy.port))).toMatchObject({
        kind: 'exited',
        exitCode: 1,
        log: expect.stringContaining('azure request failed: 403 AuthorizationPermissionMismatch'),
      });
      expect(await readStoredDocuments(container)).toEqual(storedDocuments);
    },
  );

  test('refuses to start on a database that is not JSON, and leaves it as it was', async () => {
    const corrupt = azurite.container('corrupt');
    await corrupt.create();
    await corrupt.getBlockBlobClient(DATABASE_BLOB).uploadData(Buffer.from('{"list":'));
    const before = await readBlob(corrupt, DATABASE_BLOB);
    expect(await failedStart('corrupt')).toMatchObject({
      kind: 'exited',
      exitCode: 1,
      log: expect.stringContaining('the verdaccio database is not valid JSON'),
    });
    expect(await readBlob(corrupt, DATABASE_BLOB)).toEqual(before);
  });

  test('refuses to start when the container does not exist, and creates nothing', async () => {
    expect(await failedStart('missing')).toMatchObject({
      kind: 'exited',
      exitCode: 1,
      log: expect.stringContaining('azure request failed: 404 ContainerNotFound'),
    });
    expect(await azurite.container('missing').exists()).toBe(false);
  });

  test('refuses to start while Azure Storage is unreachable, and the stored database survives', async () => {
    await azurite.stop();
    expect(await failedStart(CONTAINER)).toMatchObject({
      kind: 'exited',
      exitCode: 1,
      log: expect.stringContaining('azure request failed: no response ECONNREFUSED'),
    });

    azurite = teardown.add(await Azurite.start({ location, port: azurite.port }));
    // The same bytes and ETags: nothing was written while the reads failed.
    expect(await readStoredDocuments(container)).toEqual(storedDocuments);
    expect((await readDatabase(container)).database.list).toEqual([PACKAGE]);
    expect((await readTokens(container)).tokens).toMatchObject([{ user: USER }]);

    const verdaccio = await startVerdaccio();
    // The token decrypts only with the stored secret, and Verdaccio also looks its key up in the stored tokens.
    const tokenUser = await Npm.create(join(directory, 'token-user'), verdaccio.url, apiToken);
    expect((await tokenUser.exec(['whoami'])).trim()).toBe(USER);
    expect(await npm.json(['token', 'list'], ListedTokens)).toHaveLength(1);
    expect(await npm.json(['view', PACKAGE, 'version'], z.string())).toBe(VERSION);
  });
});
