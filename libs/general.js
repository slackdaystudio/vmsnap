import { exit } from 'process';
import { access } from 'fs/promises';
import dayjs from 'dayjs';
import commandExists from 'command-exists';
import { lockfile, logger } from '../index.js';
import { unlock } from 'lockfile';
import { VIRSH } from './virsh.js';
import { QEMU_IMG } from './qemu-img.js';
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
    };

    unlock(lockfile, (err) => {
      if (err) {
        logger.error(err);

        exit(ERR_LOCK_RELEASE);
      }

      exit(exitCode);
    });
  };

export {
  checkDependencies,
  getPreviousBackupFolder,
  parseArrayParam,
  isLastMonthsBackupCreated,
  releaseLock,
};
