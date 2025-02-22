import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import ignore from "ignore";
import xxhash from "xxhash-wasm";
import {
  createNamespace,
  listNamespaceKeys,
  listNamespaces,
  putBulkKeyValue,
  deleteBulkKeyValue,
} from "./kv";
import type { Config } from "./config";
import type { KeyValue } from "./kv";
import type { XXHashAPI } from "xxhash-wasm";

/** Paths to always ignore. */
const ALWAYS_IGNORE = new Set(["node_modules"]);
const HIDDEN_FILES_TO_INCLUDE = new Set([
  ".well-known", // See https://datatracker.ietf.org/doc/html/rfc8615
]);

async function* getFilesInFolder(dirPath: string): AsyncIterable<string> {
  const files = await readdir(dirPath, { withFileTypes: true });
  for (const file of files) {
    // Skip files that we never want to process.
    if (ALWAYS_IGNORE.has(file.name)) {
      continue;
    }
    // Skip hidden files (starting with .) except for some special ones
    if (file.name.startsWith(".") && !HIDDEN_FILES_TO_INCLUDE.has(file.name)) {
      continue;
    }
    // TODO: follow symlinks??
    if (file.isDirectory()) {
      yield* await getFilesInFolder(path.join(dirPath, file.name));
    } else {
      yield path.join(dirPath, file.name);
    }
  }
}

/**
 * Create a hash key for the given content using the xxhash algorithm.
 *
 * Note we only return the first 10 characters, since we will also include the file name in the asset manifest key
 * the most important thing here is to detect changes of a single file to invalidate the cache and
 * it's impossible to serve two different files with the same name
 */
function hashFileContent(hasher: XXHashAPI, content: string): string {
  return hasher.h64ToString(content).substring(0, 10);
}

/**
 * Create a hashed asset key for the given asset.
 *
 * The key will change if the file path or content of the asset changes.
 * The algorithm used here matches that of Wrangler 1.
 */
function hashAsset(
  hasher: XXHashAPI,
  filePath: string,
  content: string
): string {
  const extName = path.extname(filePath) || "";
  const baseName = path.basename(filePath, extName);
  const directory = path.dirname(filePath);
  const hash = hashFileContent(hasher, content);
  return urlSafe(path.join(directory, `${baseName}.${hash}${extName}`));
}

async function createKVNamespaceIfNotAlreadyExisting(
  title: string,
  accountId: string
) {
  // check if it already exists
  // TODO: this is super inefficient, should be made better
  const namespaces = await listNamespaces(accountId);
  const found = namespaces.find((x) => x.title === title);
  if (found) {
    return { created: false, id: found.id };
  }

  // else we make the namespace
  const id = await createNamespace(accountId, title);
  console.log(`🌀 Created namespace for Workers Site "${title}"`);

  return {
    created: true,
    id,
  };
}

/**
 * Upload the assets found within the `dirPath` directory to the sites assets KV namespace for
 * the worker given by `scriptName`.
 *
 * @param accountId the account to upload to.
 * @param scriptName the name of the worker whose assets we are uploading.
 * @param siteAssets an objects describing what assets to upload, or undefined if there are no assets to upload.
 * @param preview if true then upload to a "preview" KV namespace.
 * @returns a promise for an object mapping the relative paths of the assets to the key of that
 * asset in the KV namespace.
 */
export async function syncAssets(
  accountId: string,
  scriptName: string,
  siteAssets: AssetPaths | undefined,
  preview: boolean
): Promise<{
  manifest: { [filePath: string]: string } | undefined;
  namespace: string | undefined;
}> {
  if (siteAssets === undefined) {
    return { manifest: undefined, namespace: undefined };
  }

  const title = `__${scriptName}-workers_sites_assets${
    preview ? "_preview" : ""
  }`;
  const { id: namespace } = await createKVNamespaceIfNotAlreadyExisting(
    title,
    accountId
  );

  // let's get all the keys in this namespace
  const result = await listNamespaceKeys(accountId, namespace);
  const keys = new Set(result.map((x) => x.name));

  const manifest: Record<string, string> = {};
  const toUpload: KeyValue[] = [];

  const include = createPatternMatcher(siteAssets.includePatterns, false);
  const exclude = createPatternMatcher(siteAssets.excludePatterns, true);
  const hasher = await xxhash();

  const assetDirectory = path.join(
    siteAssets.baseDirectory,
    siteAssets.assetDirectory
  );
  for await (const absAssetFile of getFilesInFolder(assetDirectory)) {
    const assetFile = path.relative(siteAssets.baseDirectory, absAssetFile);
    if (!include(assetFile)) {
      continue;
    }
    if (exclude(assetFile)) {
      continue;
    }

    await validateAssetSize(absAssetFile, assetFile);
    console.log(`reading ${assetFile}...`);
    const content = await readFile(absAssetFile, "base64");

    const assetKey = hashAsset(hasher, assetFile, content);
    validateAssetKey(assetKey);

    // now put each of the files into kv
    if (!keys.has(assetKey)) {
      console.log(`uploading as ${assetKey}...`);
      toUpload.push({
        key: assetKey,
        value: content,
        base64: true,
      });
    } else {
      console.log(`skipping - already uploaded`);
    }

    // remove the key from the set so we know what we've already uploaded
    keys.delete(assetKey);
    manifest[path.relative(siteAssets.assetDirectory, absAssetFile)] = assetKey;
  }

  // keys now contains all the files we're deleting
  for (const key of keys) {
    console.log(`deleting ${key} from the asset store...`);
  }

  await Promise.all([
    // upload all the new assets
    putBulkKeyValue(accountId, namespace, toUpload, () => {}),
    // delete all the unused assets
    deleteBulkKeyValue(accountId, namespace, Array.from(keys), () => {}),
  ]);

  console.log("↗️  Done syncing assets");

  return { manifest, namespace };
}

function createPatternMatcher(
  patterns: string[],
  exclude: boolean
): (filePath: string) => boolean {
  if (patterns.length === 0) {
    return (_filePath) => !exclude;
  } else {
    const ignorer = ignore().add(patterns);
    return (filePath) => ignorer.test(filePath).ignored;
  }
}

async function validateAssetSize(
  absFilePath: string,
  relativeFilePath: string
) {
  const { size } = await stat(absFilePath);
  if (size > 25 * 1024 * 1024) {
    throw new Error(
      `File ${relativeFilePath} is too big, it should be under 25 MiB. See https://developers.cloudflare.com/workers/platform/limits#kv-limits`
    );
  }
}

function validateAssetKey(assetKey: string) {
  if (assetKey.length > 512) {
    throw new Error(
      `The asset path key "${assetKey}" exceeds the maximum key size limit of 512. See https://developers.cloudflare.com/workers/platform/limits#kv-limits",`
    );
  }
}

/**
 * Convert a filePath to be safe to use as a relative URL.
 *
 * Primarily this involves converting Windows backslashes to forward slashes.
 */
function urlSafe(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Information about the assets that should be uploaded
 */
export interface AssetPaths {
  /**
   * Absolute path to the root of the project.
   *
   * This is the directory containing wrangler.toml or cwd if no config.
   */
  baseDirectory: string;
  /**
   * The path to the assets directory, relative to the `baseDirectory`.
   */
  assetDirectory: string;
  /**
   * An array of patterns that match files that should be uploaded.
   */
  includePatterns: string[];
  /**
   * An array of patterns that match files that should not be uploaded.
   */
  excludePatterns: string[];
}

/**
 * Get an object that describes what assets to upload, if any.
 *
 * Uses the args (passed from the command line) if available,
 * falling back to those defined in the config.
 *
 */
export function getAssetPaths(
  config: Config,
  assetDirectory = config.site?.bucket,
  includePatterns = config.site?.include ?? [],
  excludePatterns = config.site?.exclude ?? []
): undefined | AssetPaths {
  const baseDirectory = path.resolve(
    path.dirname(config.configPath ?? "wrangler.toml")
  );

  return assetDirectory
    ? {
        baseDirectory,
        assetDirectory,
        includePatterns,
        excludePatterns,
      }
    : undefined;
}
