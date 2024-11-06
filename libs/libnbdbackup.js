import { sep } from 'path';
import { spawn } from 'child_process';
import { rm } from 'fs/promises';
import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat.js';
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js';
import dayOfYear from 'dayjs/plugin/dayOfYear.js';
import { logger } from '../vmsnap.js';
import { cleanupCheckpoints, domainExists, fetchAllDomains } from './virsh.js';
import { fileExists, parseArrayParam } from './general.js';
import { cleanupBitmaps } from './qemu-img.js';

/**
 * Our functions for interfacing with the virtnbdbackup utility.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

// The dayjs library with the advanced format plugin.  We need quarter
// resolution for the backup directories.
dayjs.extend(advancedFormat);
dayjs.extend(quarterOfYear);
dayjs.extend(dayOfYear)

export const BACKUP = 'virtnbdbackup';

const FORMAT_MONTHLY = 'YYYY-MM';

const FORMAT_QUARTERLY = 'YYYY-[Q]Q';

const FORMAT_BI_ANNUALLY = 'YYYY-';

const FORMAT_YEARLY = 'YYYY';

export const FREQUENCY_MONTHLY = 'month';

const FREQUENCY_QUARTERLY = 'quarter';

const FREQUENCY_BI_ANNUALLY = 'bi-annual';

const FREQUENCY_YEARLY = 'year';

const PRUNING_FREQUENCIES = [
  FREQUENCY_MONTHLY,
  FREQUENCY_QUARTERLY,
  FREQUENCY_BI_ANNUALLY,
  FREQUENCY_YEARLY,
];

/**
 * Returns the current months backup folder name in the format for the given
 * pruneFrequency.
 *
 * @returns {string} the current months backup folder name
 */
const getBackupFolder = (groupBy = FREQUENCY_MONTHLY, current = true) => {
  let lastFolder;

  switch (groupBy) {
    case FREQUENCY_QUARTERLY:
      lastFolder = current
        ? dayjs().format(FORMAT_QUARTERLY)
        : dayjs().subtract(3, 'months').format(FORMAT_QUARTERLY);
      break;
    case FREQUENCY_BI_ANNUALLY:
      let yearPart = dayjs().dayOfYear() >= 180 ? '2' : '1';

      if (!current) {
        yearPart = dayjs().subtract(6, 'months').dayOfYear() >= 180 ? '2' : '1';
      }

      const format = `${FORMAT_BI_ANNUALLY}p${yearPart}`;

      lastFolder = current
        ? dayjs().format(format)
        : dayjs().subtract(6, 'months').format(format);
      break;
    case FREQUENCY_YEARLY:
      lastFolder = current
        ? dayjs().format(FORMAT_YEARLY)
        : dayjs().subtract(1, 'year').format(FORMAT_YEARLY);
      break;
    case FREQUENCY_MONTHLY:
      lastFolder = current
        ? dayjs().format(FORMAT_MONTHLY)
        : dayjs().subtract(1, 'month').format(FORMAT_MONTHLY);
    default:
      return undefined;
  }

  return `vmsnap-backup-${groupBy}ly-${lastFolder}`;
};

/**
 * Performs a backup on one or more VM domains by inspecting passed in command
 * line arguments.
 *
 * @param {Object} args the command line arguments (domans, output, raw, prune)
 */
const performBackup = async ({ domains, output, raw, groupBy, prune }) => {
  if (!domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  if (!output) {
    throw new Error('No output directory specified', { code: ERR_OUTPUT_DIR });
  }

  for (const domain of await parseArrayParam(domains, fetchAllDomains)) {
    if (await isCleanupRequired(domain, groupBy, output)) {
      logger.info('Creating a new backup directory, running bitmap cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    await backup(domain, output, raw, groupBy);

    if (await isPruningRequired(domain, groupBy, prune, output)) {
      logger.info(
        'Middle of the current backup window, running a cleanup on old backups',
      );

      // Delete last months backups
      await pruneLastMonthsBackups(domain, groupBy, output);
    }
  }
};

/**
 * Checks the prune frequency to see if cleanup is required.  Pruning is only
 * required if the current months backup folder does not exist and we
 *
 * @param {string} domain the domain to check for cleanup
 * @param {string} groupBy how to group the backups by on disk (monthly,
 * quarterly, yearly)
 * @param {*} pruneFrequency how often to prune the backups
 * @param {*} path the full backup directory path
 * @returns {Promise<boolean>} true if cleanup is required, false otherwise
 */
const isCleanupRequired = async (domain, groupBy, path) => {
  const backupFolderExists = await fileExists(
    `${path}${sep}${domain}${sep}${getBackupFolder(groupBy)}`,
  );

  // Cleanup is required if the backup folder does not exist.  We do this to
  // ensure we don't overwrite the previous months backups and to establish a
  // full backup for the start of the new period.
  if (!backupFolderExists) {
    logger.info('Backup folder does not exist, cleanup required');

    return true;
  }

  return false;
};

/**
 * Checks the current date to see if pruning is required.
 *
 * @param {string} domain the domain to prune backups for
 * @param {string} groupBy the frequency to prune the backups
 * @param {string} pruneFrequency how often to prune the backups (monthly,
 * quarterly, yearly)
 * @param {string} path the full backup directory path
 * @returns true if pruning is required, false otherwise
 */
const isPruningRequired = async (domain, groupBy, pruneFrequency, path) => {
  if (pruneFrequency === false) {
    return false; // No pruning required
  }

  // If the window is not found, assume no pruning is required.
  if (!PRUNING_FREQUENCIES.includes(groupBy)) {
    logger.warn(`Invalid groupBy: ${groupBy}.  Pruning disabled`);

    return false;
  }

  const previousBackupFolder = getBackupFolder(groupBy, false);

  if (previousBackupFolder === undefined) {
    logger.info('Unable to determine previous backup folder, skipping pruning');

    return false;
  }

  const previousBackupFolderExists = await fileExists(
    `${path}${sep}${domain}${sep}${previousBackupFolder}`,
  );

  if (!previousBackupFolderExists) {
    return false;
  }

  // The number of days between the current date and the start of the backup
  // period.
  const days = dayjs().diff(getBackupStartDate(groupBy), 'days');

  logger.info(`Days since the start of the ${groupBy}: ${days}`);

  switch (groupBy.toLowerCase()) {
    case FREQUENCY_MONTHLY:
      return days >= 15;
    case FREQUENCY_QUARTERLY:
      return days >= 45;
    case FREQUENCY_BI_ANNUALLY:
      return days >= 90;
    case FREQUENCY_YEARLY:
      return days >= 180;
    default:
      // Assume no pruning is required if the frequency is invalid.
      return false;
  }
};

/**
 * Removes all backups for the previous period.  The period is determined by the
 * pruneFrequency param.
 *
 * @param {string} domain the domain to prune backups for
 * @param {*} groupBy how often to prune the backups (monthly, quarterly,
 * yearly)
 * @param {string} path the full backup directory path
 */
const pruneLastMonthsBackups = async (domain, groupBy, path) => {
  const previousBackupFolder = getBackupFolder(groupBy, false);

  if (previousBackupFolder === undefined) {
    logger.info('Unable to determine previous backup folder, skipping pruning');

    return;
  }

  logger.info(
    `Pruning ${groupBy}ly backup (${previousBackupFolder}) for ${domain}`,
  );

  await rm(`${path}${sep}${domain}${sep}${previousBackupFolder}`, {
    recursive: true,
    force: true,
  });
};

/**
 * Finds and returns the start date for the backup period.
 *
 * @param {string} groupBy the frequency to prune the backups (month, quarter,
 * year)
 * @returns {dayjs} the start date for the backup
 */
const getBackupStartDate = (groupBy) => {
  if (groupBy === FREQUENCY_BI_ANNUALLY) {
    return dayjs().startOf(FREQUENCY_MONTHLY).subtract(6, 'months');
  }
  
  if (PRUNING_FREQUENCIES.includes(groupBy)) {
    return dayjs().startOf(groupBy);
  }

  return dayjs().startOf(FREQUENCY_MONTHLY);
};

/**
 * Perform a backup of a domain, running or stopped.
 *
 * @param {Promise<string>} domain the domain to backup
 */
const backup = async (domain, outputDir, raw, groupBy) => {
  if (!(await domainExists(domain))) {
    logger.warn(`${domain} does not exist`);

    return;
  }

  const commandOpts = [
    '-S',
    '--noprogress',
    '-d',
    domain,
    '-l',
    'auto',
    '-o',
    `${outputDir}${sep}${domain}${sep}${getBackupFolder(groupBy)}`,
  ];

  if (raw) {
    commandOpts.push('--raw');
  }

  const child = spawn(BACKUP, commandOpts, {
    uid: 0,
    gid: 0,
    stdio: 'inherit',
  });

  if (child.stdout) {
    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (data) => {
      logger.info(data);
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (data) => {
      logger.error(data);
    });
  }

  // Wait for the backup to finish
  await new Promise((resolve) => {
    child.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Backup for ${domain} failed with code ${code}`);
      }

      resolve();
    });
  });
};

export { getBackupFolder, performBackup };
