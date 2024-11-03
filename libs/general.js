import { sep } from 'path';
import { exit } from 'process';
import { access, readdir, stat } from 'fs/promises';
import dayjs from 'dayjs';
import commandExists from 'command-exists';
import { unlock } from 'lockfile';
import {
  ERR_DOMAINS,
  ERR_REQS,
  ERR_SCRUB,
  lockfile,
  logger,
} from '../vmsnap.js';
import {
  cleanupCheckpoints,
  fetchAllDomains,
  findCheckpoints,
  VIRSH,
} from './virsh.js';
import { cleanupBitmaps, findBitmaps, QEMU_IMG } from './qemu-img.js';
import { BACKUP } from './libnbdbackup.js';
import { printSize } from './print.js';

/**
 * General functions used by vmsnap.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

// The format for the backup folder name
const BACKUP_FOLDER_FORMAT = 'YYYY-MM';

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

const FOLDER_RECURSION_LIMIT = 3;

/**
 * Check if all dependencies are installed
 */
const checkDependencies = async () => {
  const requiredPrograms = [VIRSH, QEMU_IMG, BACKUP];

  const missingPrograms = [];

  for (const program of requiredPrograms) {
    try {
      await commandExists(program);
    } catch (error) {
      missingPrograms.push(program);
    }
  }

  if (missingPrograms.length > 0) {
    throw new Error(
      `Missing dependencies (${missingPrograms.join(', ')})`,
      ERR_REQS,
    );
  }
};

/**
 * Checks the command line arguments to ensure only one command is being run.
 *
 * @param {object} argv the arguments passed to the script
 */
const checkCommand = ({ status, scrub, backup }) => {
  let commandCount = 0;

  if (status) {
    ++commandCount;
  }

  if (scrub) {
    ++commandCount;
  }

  if (backup) {
    ++commandCount;
  }

  if (commandCount > 1) {
    throw new Error(
      'Only one command can be run at a time',
      ERR_TO_MANY_COMMANDS,
    );
  }
};

/**
 * Returns the current months backup folder name in the format YYYY-MM.
 *
 * @returns {string} the current months backup folder name
 */
const getBackupFolder = () => dayjs().format(BACKUP_FOLDER_FORMAT);

/**
 * Returns last months backup folder name.
 *
 * @returns {string} Previous month in the format YYYY-MM
 */
const getPreviousBackupFolder = () => {
  return dayjs().subtract(1, 'month').format(BACKUP_FOLDER_FORMAT);
};

/**
 * Parses a string parameter for an array.
 *
 * @param {string} param the string param to parse for an array
 * @param {function} fetchAll what to call to fetch all the items
 * @returns {Promise<Array<string>>} the parsed array
 */
const parseArrayParam = async (param, fetchAll = async () => []) => {
  let parsed = [];

  if (param === undefined || typeof param !== 'string') {
    return parsed;
  }

  if (param.indexOf(',') > -1) {
    parsed = param.split(',');
  } else if (param === '*') {
    parsed = await fetchAll();
  } else if (typeof param === 'string') {
    parsed.push(param);
  } else {
    throw new Error(`Invalid parameter: ${param}`);
  }

  return parsed;
};

const fileExists = async (path) => {
  try {
    await access(path);

    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Checks to see if the last month's backups directory exists.
 *
 * @param {pathlike} lastMonthsBackupsDir a pathlike object to the last month's
 * backups directory
 * @returns true if the last month's backups directory exists, false otherwise
 */
const isLastMonthsBackupCreated = async (lastMonthsBackupsDir) => {
  return await fileExists(lastMonthsBackupsDir);
};

/**
 * Checks to see if the backup directory for the domain exists for the current
 * month.
 *
 * @param {string} domain the domain to check
 * @param {*} path the path to the backup directory root
 * @returns true if the backup directory for the domain exists, false otherwise
 */
const isThisMonthsBackupCreated = async (domain, path) => {
  return await fileExists(`${path}${sep}${domain}${sep}${getBackupFolder()}`);
};

/**
 * Scrubs off the checkpoints and bitmaps for the domains passed in.
 *
 * @returns {Promise<boolean>} true if the scrubbing was successful, false if
 * there was a failure.
 */
const scrubCheckpointsAndBitmaps = async (domains) => {
  if (!domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  logger.info('Scrubbing checkpoints and bitmaps');

  let scrubbed = false;

  try {
    for (const domain of await parseArrayParam(domains, fetchAllDomains)) {
      logger.info(`Scrubbing domain: ${domain}`);

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    scrubbed = true;
  } catch (err) {
    logger.error(err.message, { code: ERR_SCRUB });

    scrubbed = false;
  }

  return scrubbed;
};

/**
 * Release the lock created by the execution of the script.
 *
 * @param {number} exitCode the exit code to use after releasing the lock
 */
const releaseLock = (exitCode) => {
  if (exitCode === undefined) {
    logger.info('No exit code provided for lock release');
  }

  unlock(lockfile, (err) => {
    if (err) {
      logger.error(err);

      exit(ERR_LOCK_RELEASE);
    }

    exit(parseInt(exitCode) || 99);
  });
};

/**
 * Returns the key corresponding to a given value in a map.
 *
 * @param {Map<any, string>} map - A map to search for the key by value.
 * @param {any} value - The value to search for in the map.
 * @returns {any} The key of the map corresponding to the value, or undefined
 * if not found.
 */
const findKeyByValue = (map, value) => {
  for (const [key, val] of map.entries()) {
    if (val === value) {
      return key;
    }
  }

  return undefined;
};

/**
 * Creates a JSON representation of Domains, checkpoints, disks, and bitmaps.
 *
 * @param {string} rawDomains - A domain or list of domains to get the status
 * of.
 * @param {string} [path] - The path to the backup directory root.
 * @returns {Promise<object>} A JSON object representing the status of the
 * domains.
 */
const status = async (rawDomains, path = undefined, pretty = false) => {
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

      diskJson.virtualSize = printSize(record.virtualSize, pretty);

      diskJson.actualSize = printSize(record.actualSize, pretty);

      diskJson.bitmaps = [];

      for (const b of record.bitmaps) {
        diskJson.bitmaps.push(b.name);
      }

      currentJson.disks.push(diskJson);

      diskJson = {};
    }

    currentJson.overallStatus = getOverallStatus(currentJson);

    json[domain] = currentJson;

    if (path && typeof path === 'string') {
      await addBackupStats(domain, json, path, pretty);
    }

    currentJson = {};
  }

  return json;
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
 * Inspects the backup directory for the domain and adds stats to the JSON.
 *
 * @param {string} domain the domain to add backup stats for
 * @param {*} json the JSON object to add the stats to
 * @param {*} path the path to the backup directory root
 * @param {boolean} pretty whether to pretty print the size of disks or not
 */
const addBackupStats = async (domain, json, path, pretty = false) => {
  const stats = {
    path: null,
    totalFiles: 0,
    checkpoints: 0,
    totalSize: 0,
  };

  const rootDir = `${path}${sep}${domain}${sep}${getBackupFolder()}`;

  const checkpointDir = `${rootDir}${sep}checkpoints`;

  if ((await fileExists(rootDir)) && (await fileExists(checkpointDir))) {
    const checkpoints = await readdir(`${rootDir}${sep}checkpoints`);

    let fsStats;

    let checkpointSize = 0;

    for (const checkpoint of checkpoints) {
      fsStats = await stat(`${rootDir}${sep}checkpoints${sep}${checkpoint}`);

      checkpointSize += fsStats.size;
    }

    stats.path = rootDir;
    stats.totalFiles = checkpoints.length;
    stats.checkpoints = checkpoints.length;
    stats.totalSize = checkpointSize;

    await collectDirStats(stats, rootDir);
  }

  json[domain].backupDirStats = {
    ...stats,
    totalSize: printSize(stats.totalSize, pretty),
  };
};

/**
 * Drills down into the directory and collects stats for the directory and its
 * child directories up FOLDER_RECURSION_LIMIT levels.
 *
 * Recursion.
 *
 * @param {*} stats the stats object to add stats to
 * @param {*} path the path to the directory to collect stats for
 * @execCount {number} the number of times the function been called recursively
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
      collectDirStats(stats, currentPath, ++recursionCount);
    }

    stats.totalFiles++;
    stats.totalSize += fsStats.size;
  }
};

export {
  checkDependencies,
  checkCommand,
  getBackupFolder,
  getPreviousBackupFolder,
  parseArrayParam,
  isThisMonthsBackupCreated,
  isLastMonthsBackupCreated,
  scrubCheckpointsAndBitmaps,
  releaseLock,
  findKeyByValue,
  status,
};
