import { exit } from 'process';
import { access, readdir, stat } from 'fs/promises';
import dayjs from 'dayjs';
import commandExists from 'command-exists';
import prettyBytes from 'pretty-bytes';
import { unlock } from 'lockfile';
import { ERR_MAIN, lockfile, logger, SCREEN_SIZE } from '../vmsnap.js';
import {
  fetchAllDisks,
  fetchAllDomains,
  findCheckpoints,
  VIRSH,
} from './virsh.js';
import { findBitmaps, QEMU_IMG } from './qemu-img.js';
import { BACKUP } from './libnbdbackup.js';

/**
 * General functions used by vmsnap.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

/**
 * Check if all dependencies are installed
 */
const checkDependencies = async () => {
  try {
    await commandExists(VIRSH);
    await commandExists(QEMU_IMG);
    await commandExists(BACKUP);
  } catch (error) {
    throw new Error(
      `Missing dependencies: check for ${VIRSH}, ${QEMU_IMG} and ${BACKUP}`,
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
    logger.error('Only one command can be run at a time');

    releaseLock(ERR_MAIN);
  }
};

/**
 * Returns the current months backup folder name in the format YYYY-MM.
 *
 * @returns {string} the current months backup folder name
 */
const getBackupFolder = () => dayjs().format('YYYY-MM');

/**
 * Returns last months backup folder name.
 *
 * @returns {string} Previous month in the format YYYY-MM
 */
const getPreviousBackupFolder = () => {
  return dayjs().subtract(1, 'month').format('YYYY-MM');
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

/**
 * Checks to see if the last month's backups directory exists.
 *
 * @param {pathlike} lastMonthsBackupsDir a pathlike object to the last month's
 * backups directory
 * @returns true if the last month's backups directory exists, false otherwise
 */
const isLastMonthsBackupCreated = async (lastMonthsBackupsDir) => {
  try {
    await access(lastMonthsBackupsDir);

    return true;
  } catch (error) {
    return false;
  }
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
  try {
    await access(`${path}/${domain}/${getBackupFolder()}`);

    return true;
  } catch (error) {
    return false;
  }
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

    exit(exitCode || 99);
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
 * @param {boolean} [logging] - Whether to log the status of the domains.
 * @param {string} [path] - The path to the backup directory root.
 * @returns {Promise<object>} A JSON object representing the status of the
 * domains.
 */
const status = async (rawDomains, logging = true, path = undefined) => {
  const json = {};

  const domains = await parseArrayParam(rawDomains, fetchAllDomains);

  let currentJson = {};

  let domainDisks;

  if (logging) {
    logger.info(`Getting statuses for domains: ${domains.join(', ')}`);
  }

  for (const domain of domains) {
    const checkpoints = await findCheckpoints(domain);

    currentJson.checkpoints = [];

    domainDisks = [...(await fetchAllDisks(domain)).keys()] || [];

    for (const checkpoint of checkpoints) {
      currentJson.checkpoints.push(checkpoint);
    }

    const records = await findBitmaps(domain);

    currentJson.disks = [];

    let diskJson = {};

    for (const record of records) {
      diskJson.disk = record.disk;

      diskJson.virtualSize = record.virtualSize;

      diskJson.actualSize = record.actualSize;

      diskJson.bitmaps = [];

      for (const b of record.bitmaps) {
        diskJson.bitmaps.push(b.name);
      }

      currentJson.disks.push(diskJson);

      diskJson = {};
    }

    json[domain] = currentJson;

    if (path && typeof path === 'string') {
      await addBackupStats(domain, json, path);
    }

    domainDisks = undefined;

    currentJson = {};
  }

  return json;
};

/**
 * Inspects the backup directory for the domain and adds stats to the JSON.
 *
 * @param {string} domain the domain to add backup stats for
 * @param {*} json the JSON object to add the stats to
 * @param {*} path the path to the backup directory root
 */
const addBackupStats = async (domain, json, path) => {
  const root = `${path}/${domain}/${getBackupFolder()}`;

  const checkpoints = await readdir(`${root}/checkpoints`);

  const stats = {
    path: root,
    totalFiles: checkpoints.length,
    checkpoints: checkpoints.length,
    totalSize: 0,
  };

  let fsStats;

  for (const item of await readdir(root)) {
    fsStats = await stat(`${root}/${item}`);

    stats.totalFiles++;
    stats.totalSize += fsStats.size;
  }

  json[domain].backupDirStats = stats;
};

/**
 * Prints the status of the specified domains.
 *
 * @param {Array<object>} statuses the statuses to print
 * @param {boolean} pretty whether to print the statuses with formatted disk
 * sizes or not.
 */
const printStatuses = (statuses, pretty = false) => {
  const printSize = (size) => (pretty ? prettyBytes(size) : size);

  for (const domain of Object.keys(statuses)) {
    const status = statuses[domain];

    logger.info(`Status for ${domain}:`);

    if (!status.checkpoints || status.checkpoints.length === 0) {
      logger.info(`  No checkpoints found for ${domain}`);
    } else {
      logger.info(`  Checkpoints found for ${domain}:`);

      for (const checkpoint of status.checkpoints) {
        logger.info(`    ${checkpoint}`);
      }
    }

    if (status.disks.length === 0) {
      logger.info(`  No eligible disks found for ${domain}`);
    } else {
      logger.info(`  Eligible disks found for ${domain}:`);

      for (const disk of status.disks) {
        logger.info(`    ${disk.disk}`);
        logger.info(`      Virtual size: ${printSize(disk.virtualSize)}`);
        logger.info(`      Actual size: ${printSize(disk.actualSize)}`);

        if (disk.bitmaps.length === 0) {
          logger.info(`      No bitmaps found for ${disk.disk}`);
        } else {
          logger.info(`      Bitmaps found for ${disk.disk}:`);

          for (const bitmap of disk.bitmaps) {
            logger.info(`          ${bitmap}`);
          }
        }
      }
    }

    if (status.backupDirStats) {
      logger.info(`  Backup directory stats for ${domain}:`);
      logger.info(`    Path: ${status.backupDirStats.path}`);
      logger.info(`    Total files: ${status.backupDirStats.totalFiles}`);
      logger.info(
        `    Total size: ${printSize(status.backupDirStats.totalSize)}`,
      );
      logger.info(`    Checkpoints: ${status.backupDirStats.checkpoints}`);
    }
  }
};

/**
 * Frames text with a prefix and a line of hyphens.
 *
 * @param {string} prefix The prefix to display before the frame
 * @param {*} text The text to display in the frame
 * @param {boolean} trailingLb Whether to add a trailing line break
 * @returns {string} The framed text
 */
const frame = (prefix, text, trailingLb = false) => {
  const line = '-'.repeat(SCREEN_SIZE);

  return `${prefix}:\n${line}\n${text}${trailingLb ? '\n' : ''}${line}`;
};

export {
  checkDependencies,
  checkCommand,
  getBackupFolder,
  getPreviousBackupFolder,
  parseArrayParam,
  isThisMonthsBackupCreated,
  isLastMonthsBackupCreated,
  releaseLock,
  findKeyByValue,
  status,
  printStatuses,
  frame,
};
