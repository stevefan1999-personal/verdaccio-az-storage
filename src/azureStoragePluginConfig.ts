import { posix } from 'node:path';
import * as z from 'zod';
import { LOGGER_PREFIX } from './constants';

const DEFAULT_AUTH_METHOD = 'ConnectionString';

// Each key reads its AZ_STORAGE_* variable first, then the configuration file, then the schema default.
const SETTING_SOURCES: ReadonlyArray<readonly [key: string, variable?: string]> = [
  ['authMethod', 'AZ_STORAGE_AUTH_METHOD'],
  ['connectionString', 'AZ_STORAGE_CONNECTION_STRING'],
  ['accountName', 'AZ_STORAGE_ACCOUNT_NAME'],
  ['accountKey', 'AZ_STORAGE_ACCOUNT_KEY'],
  ['accountDomain', 'AZ_STORAGE_ACCOUNT_DOMAIN'],
  ['containerName', 'AZ_STORAGE_CONTAINER_NAME'],
  ['packagesDir'],
  ['cachePackageDataTime'],
  ['cachePackageTime'],
  ['appConfigConnectionString', 'AZ_STORAGE_APP_CONFIG_CONNECTION_STRING'],
  ['appConfigKeyName'],
];

const requiredText = z.string().min(1);
// 0 means no Cache-Control header, as in 1.x.
const cacheSeconds = z.coerce.number().int().nonnegative().optional();
const accountDomain = requiredText.default('blob.core.windows.net');
// The blob names join this folder with posix.join, which resolves '.' and '..', and the SDK resolves a '..'
// that is left into another container. A leading '/' would stay as an empty first folder name.
const packagesDir = requiredText
  .refine(
    (folder) => !posix.isAbsolute(folder) && !posix.normalize(folder).split('/').includes('..'),
    'packagesDir must be a relative folder inside the container',
  )
  .default('packages');

const sharedSettings = {
  containerName: requiredText,
  packagesDir,
  cachePackageDataTime: cacheSeconds,
  cachePackageTime: cacheSeconds,
  appConfigConnectionString: requiredText.optional(),
  appConfigKeyName: requiredText.default('verdaccio-db'),
};

export const AzureStorageConfigSchema = z.discriminatedUnion('authMethod', [
  z.object({ authMethod: z.literal('ConnectionString'), connectionString: requiredText, ...sharedSettings }),
  z.object({
    authMethod: z.literal('StorageSharedKeyCredential'),
    accountName: requiredText,
    accountKey: requiredText,
    accountDomain,
    ...sharedSettings,
  }),
  z.object({
    authMethod: z.literal('DefaultAzureCredential'),
    accountName: requiredText,
    accountDomain,
    ...sharedSettings,
  }),
]);

export type AzureStorageConfig = z.infer<typeof AzureStorageConfigSchema>;

// The README example leaves values empty, and YAML reads an empty value as null: both mean "not set".
const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

function layerSources(file: Record<string, unknown>, environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const layered = Object.fromEntries(
    SETTING_SOURCES.map(([key, variable]) => [key, [variable && environment[variable], file[key]].find(isSet)]),
  );
  return { ...layered, authMethod: layered.authMethod ?? DEFAULT_AUTH_METHOD };
}

/**
 * Parses the `store.az-storage` section. Verdaccio passes either the section itself or the whole
 * configuration merged with it; both carry the plugin keys at the top level, and other keys are dropped.
 */
export function parseAzureStorageConfig(source: unknown, environment: NodeJS.ProcessEnv): AzureStorageConfig {
  const result = z
    .record(z.string(), z.unknown())
    .transform((file) => layerSources(file, environment))
    .pipe(AzureStorageConfigSchema)
    .safeParse(source);
  if (result.success) {
    return result.data;
  }
  throw new Error(`${LOGGER_PREFIX}: invalid store.az-storage configuration\n${z.prettifyError(result.error)}`);
}
