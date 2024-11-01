import { exit } from 'process';
import { access } from 'fs/promises';
import dayjs from 'dayjs';
import commandExists from 'command-exists';
import { lockfile, logger, SCREEN_SIZE } from '../vmsnap.js';
import { unlock } from 'lockfile';
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
 * @param {string} [approvedDisks] - A list of approved disks to include in the
 * status check.
 * @param {boolean} [logging] - Whether to log the status of the domains.
 * @returns {Promise<object>} - A JSON object representing the status of the
 * disks and checkpoints for the domains.
 */
const status = async (
  rawDomains,
  approvedDisks = undefined,
  logging = true,
) => {
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

    domainDisks = approvedDisks
      ? await parseArrayParam(approvedDisks, async () => [
          ...(await fetchAllDisks(domain)).keys(),
        ])
      : [];

    for (const checkpoint of checkpoints) {
      currentJson.checkpoints.push(checkpoint);
    }

    const records = await findBitmaps(domain);

    currentJson.disks = [];

    const diskJson = {};

    for (const record of records) {
      diskJson.disk = record.disk;

      diskJson.bitmaps = [];

      for (const b of record.bitmaps) {
        diskJson.bitmaps.push(b.name);
      }

      currentJson.disks.push(diskJson);
    }

    json[domain] = currentJson;

    domainDisks = undefined;

    currentJson = {};
  }

  return json;
};

/**
 * Prints the status of the specified domains.
 *
 * @param {Array<object>} statuses the statuses to print
 */
const printStatuses = (statuses) => {
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

        if (disk.bitmaps.length === 0) {
        } else {
          logger.info(`      Bitmaps found for ${disk.disk}:`);

          for (const bitmap of disk.bitmaps) {
            logger.info(`          ${bitmap}`);
          }
        }
      }
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
  getPreviousBackupFolder,
  parseArrayParam,
  isLastMonthsBackupCreated,
  releaseLock,
  findKeyByValue,
  status,
  printStatuses,
  frame,
};
