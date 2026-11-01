import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  Azurite,
  E2E_CLI,
  freePort,
  isolatedEnvironment,
  LEGACY_ADAPTER_WARNING,
  runProcess,
  Teardown,
  Verdaccio,
} from './harness';

const CONTAINER = 'verdaccio';
// The battery runs every test and scenario once per package manager, with tarballs of 30 MB.
const BATTERY_TIMEOUT = 15 * 60_000;

const teardown = new Teardown();
let directory: string;
let uplinkPort: number;
let verdaccio: Verdaccio;

describe('the @verdaccio/e2e-cli battery against Verdaccio 7 with the plugin on Azurite', () => {
  beforeAll(async () => {
    directory = await teardown.temporaryDirectory('battery');
    const azurite = await Azurite.start(teardown);
    await azurite.container(CONTAINER).create();
    const store = { connectionString: azurite.connectionString, containerName: CONTAINER };
    uplinkPort = await freePort();
    verdaccio = await Verdaccio.start(teardown, join(directory, 'verdaccio'), store, {
      port: await freePort(),
      uplinkPort,
    });
  });

  afterAll(() => teardown.run());

  test(
    'passes for npm and pnpm',
    async () => {
      // The battery leaves its projects in the temporary folder, and the clients fill their caches and store:
      // all of it stays in this suite's folder, which the teardown removes.
      const temporary = join(directory, 'tmp');
      await mkdir(temporary);
      const battery = await runProcess(
        process.execPath,
        [E2E_CLI, '--registry', verdaccio.url, '--pm', 'npm', '--pm', 'pnpm', '--uplink-port', String(uplinkPort)],
        {
          cwd: directory,
          env: isolatedEnvironment({
            TMPDIR: temporary,
            npm_config_userconfig: join(directory, 'npmrc'),
            npm_config_cache: join(directory, 'npm-cache'),
            pnpm_config_store_dir: join(directory, 'pnpm-store'),
            pnpm_config_cache_dir: join(directory, 'pnpm-cache'),
            // The scratch packages can sit inside someone's git work tree (a TMPDIR under a repository): pnpm then
            // refuses to publish from the unclean tree, and `version` commits and tags in that repository. Git must
            // not look above this suite's folder.
            GIT_CEILING_DIRECTORIES: directory,
          }),
        },
      );
      expect(battery.exitCode, `${battery.stdout}${battery.stderr}`).toBe(0);
      expect(verdaccio.log()).not.toContain(LEGACY_ADAPTER_WARNING);
    },
    BATTERY_TIMEOUT,
  );
});
