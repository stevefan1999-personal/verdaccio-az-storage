import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContainerClient } from '@azure/storage-blob';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as z from 'zod';
import {
  type AzureStore,
  Azurite,
  addUser,
  blobNames,
  CreatedToken,
  freePort,
  LEGACY_ADAPTER_WARNING,
  ListedTokens,
  Npm,
  packageSource,
  readDatabase,
  readStoredDocuments,
  readTokens,
  servedIntegrity,
  Teardown,
  Verdaccio,
  writePackage,
} from './harness';

const CONTAINER = 'verdaccio';
const USER = 'e2e-publisher';
const PASSWORD = 'e2e-publisher-password';
const PACKAGES = ['@e2e-az/scoped', 'e2e-az-unscoped'];
const [FIRST, LATEST] = ['1.0.0', '1.1.0'];
const DEPRECATION = `use ${LATEST}`;

const PackageView = z.object({ versions: z.array(z.string()), 'dist-tags': z.record(z.string(), z.string()) });
const VersionView = z.object({
  dist: z.object({ tarball: z.url(), integrity: z.string() }),
  deprecated: z.string().optional(),
});
const DistTags = z.record(z.string(), z.string());

// Verdaccio names a tarball after the package name without its scope.
const tarballOf = (name: string, version: string) => `${name.split('/').pop()}-${version}.tgz`;

const teardown = new Teardown();
let directory: string;
let container: ContainerClient;
let store: AzureStore;
let port: number;
let verdaccio: Verdaccio;
let npm: Npm;
let tokenUser: Npm;

const viewPackage = (name: string) => npm.json(['view', name], PackageView);
const viewVersion = (name: string, version: string) => npm.json(['view', `${name}@${version}`], VersionView);

async function storedFiles(name: string): Promise<Set<string>> {
  const prefix = `packages/${name}/`;
  return new Set((await blobNames(container, prefix)).map((blobName) => blobName.slice(prefix.length)));
}

async function expectServedTarballsMatchIntegrity(name: string, versions: readonly string[]): Promise<void> {
  for (const version of versions) {
    const { dist } = await viewVersion(name, version);
    expect(await servedIntegrity(dist.tarball)).toBe(dist.integrity);
  }
}

describe('npm against Verdaccio 7 with the plugin on Azurite', () => {
  beforeAll(async () => {
    directory = await teardown.temporaryDirectory('registry');
    const azurite = teardown.add(await Azurite.start());
    container = azurite.container(CONTAINER);
    await container.create();
    store = { connectionString: azurite.connectionString, containerName: CONTAINER };
    port = await freePort();
    verdaccio = teardown.add(await Verdaccio.start(join(directory, 'verdaccio'), store, { port }));
    const sessionToken = await addUser(verdaccio.url, USER, PASSWORD);
    // npm token create reads the password from its configuration instead of a prompt.
    npm = await Npm.create(join(directory, 'publisher'), verdaccio.url, sessionToken, {
      npm_config_password: PASSWORD,
    });
  });

  afterAll(() => teardown.run());

  test('publishes two versions of a scoped and an unscoped package into the container', async () => {
    for (const name of PACKAGES) {
      for (const version of [FIRST, LATEST]) {
        await npm.exec(['publish'], await writePackage(directory, name, version));
      }
      expect(await storedFiles(name)).toEqual(
        new Set(['package.json', tarballOf(name, FIRST), tarballOf(name, LATEST)]),
      );
    }
    expect((await readDatabase(container)).database.list).toEqual(PACKAGES);
  });

  test('serves the metadata of both versions', async () => {
    for (const name of PACKAGES) {
      expect(await viewPackage(name)).toMatchObject({ versions: [FIRST, LATEST], 'dist-tags': { latest: LATEST } });
    }
  });

  test('installs the packages from tarballs that match the integrity in their metadata', async () => {
    const project = join(directory, 'consumer');
    await mkdir(project);
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true }));
    await npm.exec(['install', ...PACKAGES.map((name) => `${name}@${FIRST}`)], project);
    for (const name of PACKAGES) {
      expect(await readFile(join(project, 'node_modules', name, 'index.js'), 'utf8')).toBe(packageSource(name, FIRST));
      await expectServedTarballsMatchIntegrity(name, [FIRST, LATEST]);
    }
  });

  test('adds and removes a dist-tag', async () => {
    for (const name of PACKAGES) {
      await npm.exec(['dist-tag', 'add', `${name}@${FIRST}`, 'beta']);
      expect(await npm.json(['view', name, 'dist-tags'], DistTags)).toEqual({ latest: LATEST, beta: FIRST });
      await npm.exec(['dist-tag', 'rm', name, 'beta']);
      expect(await npm.json(['view', name, 'dist-tags'], DistTags)).toEqual({ latest: LATEST });
    }
  });

  test('deprecates one version', async () => {
    for (const name of PACKAGES) {
      await npm.exec(['deprecate', `${name}@${FIRST}`, DEPRECATION]);
      expect((await viewVersion(name, FIRST)).deprecated).toBe(DEPRECATION);
      expect((await viewVersion(name, LATEST)).deprecated).toBeUndefined();
    }
  });

  test('creates and lists an npm token, and stores only its mask', async () => {
    const apiToken = (await npm.json(['token', 'create'], CreatedToken)).token;
    tokenUser = await Npm.create(join(directory, 'token-user'), verdaccio.url, apiToken);
    const listed = await npm.json(['token', 'list'], ListedTokens);
    expect(listed).toHaveLength(1);
    const { text, tokens } = await readTokens(container);
    expect(tokens).toEqual([expect.objectContaining({ user: USER, key: listed[0]?.key })]);
    expect(text).not.toContain(apiToken);
    expect((await tokenUser.exec(['whoami'])).trim()).toBe(USER);
  });

  test('keeps the packages, the secret and the token after a restart, without rewriting the database', async () => {
    const before = await readStoredDocuments(container);
    expect(verdaccio.log()).not.toContain(LEGACY_ADAPTER_WARNING);
    await verdaccio.stop();
    verdaccio = teardown.add(await Verdaccio.start(join(directory, 'verdaccio'), store, { port }));
    expect(await readStoredDocuments(container)).toEqual(before);
    // The token decrypts only with the stored secret, and Verdaccio also looks its key up in the stored tokens.
    expect((await tokenUser.exec(['whoami'])).trim()).toBe(USER);
    expect(await npm.json(['token', 'list'], ListedTokens)).toHaveLength(1);
    for (const name of PACKAGES) {
      expect(await viewPackage(name)).toMatchObject({ versions: [FIRST, LATEST], 'dist-tags': { latest: LATEST } });
      expect((await viewVersion(name, FIRST)).deprecated).toBe(DEPRECATION);
      await expectServedTarballsMatchIntegrity(name, [FIRST, LATEST]);
    }
  });

  test('revokes the token, which Verdaccio then refuses', async () => {
    const [listed] = await npm.json(['token', 'list'], ListedTokens);
    await npm.exec(['token', 'revoke', z.string().parse(listed?.key)]);
    expect(await npm.json(['token', 'list'], ListedTokens)).toEqual([]);
    expect((await readTokens(container)).tokens).toEqual([]);
    expect(await tokenUser.run(['whoami'])).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('E403') });
  });

  test('unpublishes one version, then the whole package', async () => {
    for (const name of PACKAGES) {
      await npm.exec(['unpublish', `${name}@${FIRST}`]);
      expect((await viewPackage(name)).versions).toEqual([LATEST]);
      expect(await storedFiles(name)).toEqual(new Set(['package.json', tarballOf(name, LATEST)]));
      await npm.exec(['unpublish', name, '--force']);
      expect((await npm.run(['view', name])).stderr).toContain('E404');
      expect(await storedFiles(name)).toEqual(new Set());
    }
    expect((await readDatabase(container)).database.list).toEqual([]);
  });

  test('runs Verdaccio without the legacy storage adapter', () => {
    expect(verdaccio.log()).not.toContain(LEGACY_ADAPTER_WARNING);
  });
});
