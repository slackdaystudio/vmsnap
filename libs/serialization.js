import { sep } from 'path';
import { readdir, stat } from 'fs/promises';
import prettyBytes from 'pretty-bytes';
import { fileExists, parseArrayParam } from './general.js';
import { findBitmaps } from './qemu-img.js';
import { fetchAllDomains, findCheckpoints } from './virsh.js';
import { FREQUENCY_MONTHLY, getBackupFolder } from './libnbdbackup.js';

// The all-clear code for the status of a domain
export const STATUS_OK = 0;

// This code means the domain is in an inconsistent backup state.  Take a look
// at the checkpoints and bitmaps to see what's going on.
export const STATUS_INCONSISTENT = 1;

// The domains overall status codes
export const STATUSES = new Map([
  [STATUS_OK, 'OK'],
  [STATUS_INCONSISTENT, 'INCONSISTENT'],
]);

// The maximum number of times to recurse into a directory
const FOLDER_RECURSION_LIMIT = 5;

/**
 * Creates a JSON representation of Domains, checkpoints, disks, and bitmaps.
 *
 * @param {string} rawDomains - A domain or list of domains to get the status
 * of.
 * @param {string|undefined} path the path to the backup directory root.
 * @param {string} groupBy the frequency to group backups by on disk (month, 
 * quarter, or year).
 * @param {boolean} pretty whether to pretty print the size of disks or not.
 * @returns {Promise<object>} a JSON object representing the status of the
 * domains.
 */
const getStatus = async (
  rawDomains,
  path = undefined,
  groupBy = FREQUENCY_MONTHLY,
  pretty = false,
) => {
  const json = {};

  const domains = await parseArrayParam(rawDomains, fetchAllDomains);

  let currentJson = {};

  for (const domain of domains) {
    const checkpoints = await findCheckpoints(domain);

    currentJson.checkpoints = [];

    for (const checkpoint of checkpoints) {
      currentJson.checkpoints.push(checkpoint);
    }

    const records = await findBitmaps(domain);

    currentJson.disks = [];

    let diskJson = {};

    for (const record of records) {
      diskJson.disk = record.disk;

      diskJson.virtualSize = getDiskSize(record.virtualSize, pretty);

      diskJson.actualSize = getDiskSize(record.actualSize, pretty);

      diskJson.bitmaps = [];

      for (const b of record.bitmaps) {
        diskJson.bitmaps.push(b.name);
      }

      currentJson.disks.push(diskJson);

      diskJson = {};
    }

    currentJson.overallStatus = getOverallStatus(currentJson);

    if (path && typeof path === 'string') {
      await addBackupStats(domain, currentJson, path, groupBy, pretty);

      if (
        currentJson.overallStatus === STATUS_OK &&
        currentJson.backupDirStats.checkpoints !==
        currentJson.checkpoints.length
      ) {
        currentJson.overallStatus = STATUS_INCONSISTENT;
      }
    }

    json[domain] = currentJson;

    currentJson = {};
  }

  return json;
};

/**
 * Will print the size in bytes or a pretty formatted string like 25 GB or 1.5
 * MB
 *
 * @param {number} size the bytes to print
 * @param {boolean} pretty whether to pretty print the size or not
 * @returns {number|string} the size in bytes or a pretty formatted string
 */
const getDiskSize = (size, pretty = false) =>
  pretty ? prettyBytes(size) : size;

/**
 * Inspects the backup directory for the domain and adds stats to the JSON.
 *
 * @param {string} domain the domain to add backup stats for
 * @param {*} json the JSON object to add the stats to
 * @param {*} path the path to the backup directory root
 * @param {boolean} pretty whether to pretty print the size of disks or not
 */
const addBackupStats = async (domain, json, path, groupBy, pretty = false) => {
  const stats = {
    path: null,
    totalFiles: 0,
    checkpoints: 0,
    totalSize: 0,
  };

  const rootDir = `${path}${sep}${domain}${sep}${getBackupFolder(groupBy)}`;

  stats.path = rootDir;

  const checkpointDir = `${rootDir}${sep}checkpoints`;

  if ((await fileExists(rootDir)) && (await fileExists(checkpointDir))) {
    const checkpoints = await readdir(`${rootDir}${sep}checkpoints`);

    let fsStats;

    let checkpointSize = 0;

    for (const checkpoint of checkpoints) {
      fsStats = await stat(`${rootDir}${sep}checkpoints${sep}${checkpoint}`);

      checkpointSize += fsStats.size;
    }

    stats.totalFiles = checkpoints.length;
    stats.checkpoints = checkpoints.length;
    stats.totalSize = checkpointSize;

    await collectDirStats(stats, rootDir);
  }

  json.backupDirStats = {
    ...stats,
    totalSize: getDiskSize(stats.totalSize, pretty),
  };
};

/**
 * Inspects the given JSON object and returns the overall status.  This is
 * currently determined by whether the number of checkpoints and bitmaps match
 * for each disk.
 *
 * @param {object} json The JSON object to get the overall status for
 * @returns {number} The overall status for the JSON object
 */
const getOverallStatus = (json) => {
  let overallStatus = STATUS_OK;

  const checkpoints = json.checkpoints;

  let bitmaps = [];

  for (const disk of json.disks) {
    bitmaps = disk.bitmaps;

    if (checkpoints.length !== bitmaps.length) {
      overallStatus = STATUS_INCONSISTENT;

      break;
    }
  }

  return overallStatus;
};

/**
 * Drills down into the directory and collects stats for the directory and its
 * child directories up FOLDER_RECURSION_LIMIT levels.
 *
 * Recursion.
 *
 * @param {*} stats the stats object to add stats to
 * @param {*} path the path to the directory to collect stats for
 * @param {*} recursionCount the number of times the function has been called
 */
const collectDirStats = async (stats, path, recursionCount = 0) => {
  if (recursionCount === FOLDER_RECURSION_LIMIT) {
    throw new Error(`Recursion limit reached for ${path}`);
  }

  let fsStats;

  let currentPath;

  for (const item of await readdir(path)) {
    currentPath = `${path}${sep}${item}`;

    fsStats = await stat(currentPath);

    if (fsStats.isDirectory()) {
      await collectDirStats(stats, currentPath, ++recursionCount);
    }

    stats.totalFiles++;
    stats.totalSize += fsStats.size;
  }
};

export { getStatus };
