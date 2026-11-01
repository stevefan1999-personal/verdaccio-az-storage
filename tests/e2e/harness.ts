import { type ChildProcess, fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import * as z from 'zod';
import { AZURITE_ACCOUNT_KEY, AZURITE_ACCOUNT_NAME } from '../fakes';

const NODE_MODULES = join(__dirname, '..', '..', 'node_modules');
const AZURITE_BLOB = join(NODE_MODULES, 'azurite', 'dist', 'src', 'blob', 'main.js');
// The package self-link in node_modules makes Verdaccio load the built lib/ as `verdaccio-az-storage`.
const VERDACCIO = join(NODE_MODULES, 'verdaccio', 'bin', 'verdaccio');
export const E2E_CLI = join(NODE_MODULES, '@verdaccio', 'e2e-cli', 'bin', 'e2e-cli.js');
export const DATABASE_BLOB = '.verdaccio-db.json';
export const TOKENS_BLOB = '.verdaccio-tokens.json';
export const LEGACY_ADAPTER_WARNING = 'legacy callback-based storage plugin';

// The caller's AZ_STORAGE_* would point the plugin at a real account, and pnpm exports npm_config_* that
// would send the clients elsewhere. Without NODE_ENV=test from vitest, Verdaccio runs as in production.
const CALLER_SETTING = /^(AZ_STORAGE_|npm_config_|pnpm_config_)|^NODE_ENV$/i;

export function isolatedEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !CALLER_SETTING.test(name));
  return { ...Object.fromEntries(inherited), ...overrides };
}

export type Completed = { exitCode: number | null; stdout: string; stderr: string };

function collect(stream: Readable | null): () => string {
  const chunks: Buffer[] = [];
  stream?.on('data', (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString();
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<Completed> {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, stdout: stdout(), stderr: stderr() };
}

export function expectSuccess({ exitCode, stdout, stderr }: Completed): string {
  if (exitCode !== 0) {
    throw new Error(`exited with code ${exitCode}\n${stderr}${stdout}`);
  }
  return stdout;
}

// 'close' comes after the output is drained, so the caller sees the whole log.
async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
}

type Service = { stop(): Promise<void> };

/** Stops what a suite started and deletes its folders, newest first, also when its setup failed halfway. */
export class Teardown {
  private readonly steps: Array<() => Promise<void>> = [];

  add<Started extends Service>(service: Started): Started {
    this.steps.unshift(() => service.stop());
    return service;
  }

  async temporaryDirectory(purpose: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), `verdaccio-az-storage-${purpose}-`));
    this.steps.unshift(() => rm(path, { recursive: true, force: true }));
    return path;
  }

  async run(): Promise<void> {
    for (const step of this.steps.splice(0)) {
      await step();
    }
  }
}

export async function freePort(): Promise<number> {
  const server = createServer().listen(0, 'localhost');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

export const azuriteConnectionString = (port: number): string =>
  [
    'DefaultEndpointsProtocol=http',
    `AccountName=${AZURITE_ACCOUNT_NAME}`,
    `AccountKey=${AZURITE_ACCOUNT_KEY}`,
    `BlobEndpoint=http://127.0.0.1:${port}/${AZURITE_ACCOUNT_NAME}`,
  ].join(';');

/** An Azurite blob service in memory, or in `location` so that a restart on the same port keeps the data. */
export class Azurite {
  readonly port: number;
  readonly connectionString: string;
  private readonly child: ChildProcess;

  private constructor(child: ChildProcess, port: number) {
    this.child = child;
    this.port = port;
    this.connectionString = azuriteConnectionString(port);
  }

  static async start(
    teardown: Teardown,
    { port = 0, location }: { port?: number; location?: string } = {},
  ): Promise<Azurite> {
    if (location !== undefined) {
      await mkdir(location, { recursive: true });
    }
    const persistence = location === undefined ? ['--inMemoryPersistence'] : ['--location', location];
    const child = spawn(
      process.execPath,
      [
        AZURITE_BLOB,
        ...['--blobHost', '127.0.0.1', '--blobPort', String(port), ...persistence],
        ...['--disableTelemetry', '--skipApiVersionCheck', '--loose', '--silent'],
      ],
      { env: isolatedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // Registered before the wait, so an Azurite that never listens is stopped too.
    teardown.add({ stop: () => stopProcess(child) });
    const output = collect(child.stdout);
    const listeningPort = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => reject(new Error(`azurite exited with code ${exitCode}\n${output()}`)));
      child.stdout?.on('data', () => {
        const listening = /successfully listens on http:\/\/[^\s:]+:(\d+)/.exec(output());
        if (listening) {
          resolve(Number(listening[1]));
        }
      });
    });
    return new Azurite(child, listeningPort);
  }

  container(name: string): ContainerClient {
    return BlobServiceClient.fromConnectionString(this.connectionString).getContainerClient(name);
  }

  stop(): Promise<void> {
    return stopProcess(this.child);
  }
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const DENIED_READ = '<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthorizationPermissionMismatch</Code></Error>';

/**
 * Forwards to Azurite but answers 403 to every read of one blob, as a role that may write but not read would.
 * Writes still reach Azurite, so a plugin that took the failed read for "missing" would replace the blob.
 */
export async function startReadDenyingProxy(
  targetPort: number,
  deniedBlobName: string,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createHttpServer((request, response) => {
    if (READ_METHODS.has(request.method ?? '') && request.url?.split('?')[0]?.endsWith(`/${deniedBlobName}`)) {
      response.writeHead(403, {
        'content-type': 'application/xml',
        'x-ms-error-code': 'AuthorizationPermissionMismatch',
      });
      response.end(DENIED_READ);
      return;
    }
    const { method, url: path, headers } = request;
    const forwarded = httpRequest({ host: '127.0.0.1', port: targetPort, method, path, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    forwarded.on('error', (error) => response.destroy(error));
    request.pipe(forwarded);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    port,
    stop: async () => {
      if (!server.listening) {
        return;
      }
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}

export type AzureStore = { connectionString: string; containerName: string };
type LaunchOptions = { port: number; uplinkPort?: number };
export type VerdaccioLaunch =
  | { kind: 'started'; verdaccio: Verdaccio }
  | { kind: 'exited'; exitCode: number | null; log: string };

const StartedMessage = z.object({ verdaccio_started: z.literal(true) });

// The e2e battery's recommended configuration, with the plugin as the store. Without a storage key,
// a plugin that fails to load stops Verdaccio instead of falling back to local files.
async function writeConfig(directory: string, store: AzureStore, uplinkPort: number | undefined): Promise<string> {
  const uplink = uplinkPort === undefined ? [] : ['--uplink-port', String(uplinkPort)];
  const printed = expectSuccess(
    await runProcess(process.execPath, [E2E_CLI, '--print-config', ...uplink], { env: isolatedEnvironment() }),
  );
  const storeSection = [
    'store:',
    '  az-storage:',
    `    connectionString: ${JSON.stringify(store.connectionString)}`,
    `    containerName: ${JSON.stringify(store.containerName)}`,
  ];
  const configPath = join(directory, 'config.yaml');
  await writeFile(configPath, [printed.replace(/^storage: .*$/m, ''), ...storeSection, ''].join('\n'));
  return configPath;
}

/** Verdaccio 7 from node_modules. Its directory keeps the configuration and htpasswd across restarts. */
export class Verdaccio {
  readonly url: string;
  private readonly child: ChildProcess;
  private readonly output: () => string;

  private constructor(child: ChildProcess, port: number, output: () => string) {
    this.child = child;
    this.output = output;
    // The battery writes its .npmrc for localhost, so every client uses that name.
    this.url = `http://localhost:${port}/`;
  }

  static async launch(
    teardown: Teardown,
    directory: string,
    store: AzureStore,
    { port, uplinkPort }: LaunchOptions,
  ): Promise<VerdaccioLaunch> {
    await mkdir(directory, { recursive: true });
    const configPath = await writeConfig(directory, store, uplinkPort);
    const child = fork(VERDACCIO, ['--config', configPath, '--listen', `localhost:${port}`], {
      cwd: directory,
      env: isolatedEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    // Registered before the wait, so a Verdaccio that neither listens nor exits is stopped too.
    teardown.add({ stop: () => stopProcess(child) });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    const output = () => stdout() + stderr();
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve({ kind: 'exited', exitCode, log: output() }));
      // Verdaccio sends this on its IPC channel once it listens, so no request is made before.
      child.on('message', (message) => {
        if (StartedMessage.safeParse(message).success) {
          resolve({ kind: 'started', verdaccio: new Verdaccio(child, port, output) });
        }
      });
    });
  }

  static async start(
    teardown: Teardown,
    directory: string,
    store: AzureStore,
    options: LaunchOptions,
  ): Promise<Verdaccio> {
    const launch = await Verdaccio.launch(teardown, directory, store, options);
    if (launch.kind === 'exited') {
      throw new Error(`verdaccio exited with code ${launch.exitCode} before it listened\n${launch.log}`);
    }
    return launch.verdaccio;
  }

  log(): string {
    return this.output();
  }

  stop(): Promise<void> {
    return stopProcess(this.child);
  }
}

const UserToken = z.object({ token: z.string().min(1) });
// What `npm token create --json` and `npm token list --json` print.
export const CreatedToken = UserToken;
export const ListedTokens = z.array(z.object({ key: z.string() }));

/** Signs a new user up through htpasswd, as `npm adduser` does, and returns its session token. */
export async function addUser(registry: string, name: string, password: string): Promise<string> {
  const response = await fetch(new URL(`-/user/org.couchdb.user:${name}`, registry), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  if (!response.ok) {
    throw new Error(`adding the user ${name} answered ${response.status}`);
  }
  return UserToken.parse(await response.json()).token;
}

/** npm with its own configuration and cache. The token stays in a file, never on a command line. */
export class Npm {
  private readonly directory: string;
  private readonly environment: NodeJS.ProcessEnv;

  private constructor(directory: string, environment: NodeJS.ProcessEnv) {
    this.directory = directory;
    this.environment = environment;
  }

  static async create(directory: string, registry: string, token: string, settings: NodeJS.ProcessEnv = {}) {
    await mkdir(directory, { recursive: true });
    const userconfig = join(directory, 'npmrc');
    // npm finds a token under the registry URL without its protocol.
    await writeFile(userconfig, `registry=${registry}\n${registry.replace(/^https?:/, '')}:_authToken=${token}\n`, {
      mode: 0o600,
    });
    return new Npm(
      directory,
      isolatedEnvironment({
        npm_config_userconfig: userconfig,
        npm_config_cache: join(directory, 'cache'),
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        ...settings,
      }),
    );
  }

  run(args: readonly string[], cwd = this.directory): Promise<Completed> {
    return runProcess('npm', args, { cwd, env: this.environment });
  }

  async exec(args: readonly string[], cwd?: string): Promise<string> {
    return expectSuccess(await this.run(args, cwd));
  }

  async json<Output>(args: readonly string[], schema: z.ZodType<Output>, cwd?: string): Promise<Output> {
    return schema.parse(JSON.parse(await this.exec([...args, '--json'], cwd)));
  }
}

/** A package whose index.js names its own version, so an install shows which tarball it unpacked. */
export async function writePackage(directory: string, name: string, version: string): Promise<string> {
  const packageDirectory = join(directory, 'packages', name, version);
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  await writeFile(join(packageDirectory, 'index.js'), packageSource(name, version));
  return packageDirectory;
}

export const packageSource = (name: string, version: string): string =>
  `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`;

export async function servedIntegrity(tarballUrl: string): Promise<string> {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`${tarballUrl} answered ${response.status}`);
  }
  const digest = createHash('sha512').update(Buffer.from(await response.arrayBuffer()));
  return `sha512-${digest.digest('base64')}`;
}

export type StoredBlob = { text: string; etag: string };

export async function readBlob(container: ContainerClient, blobName: string): Promise<StoredBlob> {
  const { etag, readableStreamBody } = await container.getBlobClient(blobName).download();
  if (etag === undefined || readableStreamBody === undefined) {
    throw new Error(`${blobName} was downloaded without an etag or a body`);
  }
  return { text: await text(readableStreamBody), etag };
}

export async function blobNames(container: ContainerClient, prefix: string): Promise<string[]> {
  return (await Array.fromAsync(container.listBlobsFlat({ prefix }))).map(({ name }) => name);
}

const StoredDatabase = z.object({ list: z.array(z.string()), secret: z.string() });
const StoredTokens = z.object({
  tokens: z.array(z.object({ user: z.string(), key: z.string(), token: z.string() })),
});

export async function readDatabase(container: ContainerClient) {
  const stored = await readBlob(container, DATABASE_BLOB);
  return { ...stored, database: StoredDatabase.parse(JSON.parse(stored.text)) };
}

export async function readTokens(container: ContainerClient) {
  const stored = await readBlob(container, TOKENS_BLOB);
  return { ...stored, tokens: StoredTokens.parse(JSON.parse(stored.text)).tokens };
}

/** The bytes and ETags of both database blobs, to show that nothing rewrote them. */
export const readStoredDocuments = (container: ContainerClient): Promise<StoredBlob[]> =>
  Promise.all([readBlob(container, DATABASE_BLOB), readBlob(container, TOKENS_BLOB)]);
