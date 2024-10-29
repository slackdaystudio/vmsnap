import { access } from 'fs/promises';
import dayjs from 'dayjs';
import commandExists from 'command-exists';
import { VIRSH, fetchAllDomains } from './virsh.js';
import { QEMU_IMG } from './qemu-img.js';
import { BACKUP } from './libnbdbackup.js';

/**
 * General functions used by vmsnap.
 *
 * @author: Philip J. Guinchard <phil.guinchardard@slackdaystudio.ca>
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
 * Inspects the --domains CLI argument and returns a list of domains to backup.
 *
 * @returns {Promise<Array<string>>} List of domains to backup
 */
const parseDomains = async (rawDomains) => {
  let domains = [];

  if (rawDomains.indexOf(',') > -1) {
    domains = rawDomains.split(',');
  } else if (rawDomains === '*') {
    domains = await fetchAllDomains();
  } else if (typeof rawDomains === 'string') {
    domains.push(rawDomains);
  } else {
    throw new Error(`Invalid domain name: ${rawDomains}`);
  }

  return domains;
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

export {
  checkDependencies,
  getPreviousBackupFolder,
  parseDomains,
  isLastMonthsBackupCreated,
};
