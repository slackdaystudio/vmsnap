import { sep } from 'path';
import { spawn } from 'child_process';
import { rm } from 'fs/promises';
import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat.js';
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

export const BACKUP = 'virtnbdbackup';

const FORMAT_MONTHLY = 'YYYY-MM';

const FORMAT_QUARTERLY = 'YYYY-[Q]Q';

const FORMAT_YEARLY = 'YYYY';

export const FREQUENCY_MONTHLY = 'month';

const FREQUENCY_QUARTERLY = 'quarter';

const FREQUENCY_YEARLY = 'year';

const PRUNING_FREQUENCIES = [
  FREQUENCY_MONTHLY, 
  FREQUENCY_QUARTERLY,
  FREQUENCY_YEARLY,
];

/**
 * Returns the current months backup folder name in the format for the given
 * pruneFrequency.
 *
 * @returns {string} the current months backup folder name
 */
const getBackupFolder = (groupBy = FREQUENCY_MONTHLY) => {
  let backupFolder;

  switch (groupBy) {
    case FREQUENCY_QUARTERLY:
      backupFolder = dayjs().format(FORMAT_QUARTERLY);
      break;
    case FREQUENCY_YEARLY:
      backupFolder = dayjs().format(FORMAT_YEARLY);
      break;
    case FREQUENCY_MONTHLY:
    default:
      backupFolder = dayjs().format(FORMAT_MONTHLY);
  }

  return `vmsnap-backup-${groupBy}ly-${backupFolder}`;
};

/**
 * Performs a backup on one or more VM domains by inspecting passed in command
 * line arguments.
 *
 * @param {Object} args the command line arguments (domans, output, raw, prune)
 */
const performBackup = async ({
  domains,
  output,
  raw,
  groupBy,
  prune,
}) => {
  if (!domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  if (!output) {
    throw new Error('No output directory specified', { code: ERR_OUTPUT_DIR });
  }

  for (const domain of await parseArrayParam(domains, fetchAllDomains)) {
    if (await isCleanupRequired(domain, groupBy, prune, output)) {
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
const isCleanupRequired = async (domain, groupBy, pruneFrequency, path) => {
  // We're not pruning, so no cleanup is required.
  if (pruneFrequency === undefined || pruneFrequency === false) {
    return false;
  }

  const currentBackupFolderExists = await fileExists(
    `${path}${sep}${domain}${sep}${getBackupFolder(groupBy)}`,
  );

  // Cleanup is required if the backup folder does not exist.  We do this to
  // ensure we don't overwrite the previous months backups and to establish a
  // full backup for the start of the new period.
  //
  // If the backup folder exists, we assume the cleanup has already been done.
  return currentBackupFolderExists === false;
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
const isPruningRequired = async (
  domain,
  groupBy,
  pruneFrequency,
  path,
) => {
  if (pruneFrequency === undefined || pruneFrequency === false) {
    return false; // No pruning required
  }

  // If the window is not found, assume no pruning is required.
  if (!PRUNING_FREQUENCIES.includes(groupBy)) {
    logger.warn(`Invalid prune frequency: ${groupBy}.  Pruning disabled`);

    return false;
  }

  const previousBackupFolderExists = await fileExists(
    `${path}${sep}${domain}${sep}${getPreviousBackupFolder(groupBy)}`,
  );

  if (!previousBackupFolderExists) {
    return false;
  }

  // The number of days between the current date and the start of the backup
  // period.
  const days = getBackupStartDate(groupBy).diff(dayjs().date(), 'days');

  switch (groupBy) {
    case FREQUENCY_MONTHLY:
      return days >= 15;
    case FREQUENCY_QUARTERLY:
      return days >= 45;
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
  const previousBackupFolder = getPreviousBackupFolder(groupBy);

  console.info(
    `Pruning ${window} backup (${previousBackupFolder}) for ${domain}`,
  );

  await rm(`${path}${sep}${domain}${sep}${previousBackupFolder}`, {
    recursive: true,
    force: true,
  });
};

/**
 *
 * @param {string} groupBy the frequency to prune the backups (monthly,
 * quarterly, yearly)
 * @returns {dayjs} the start date for the backup
 */
const getBackupStartDate = (groupBy) => {
  switch (groupBy.toLowerCase) {
    case FREQUENCY_MONTHLY:
      return dayjs().startOf('month');
    case FREQUENCY_QUARTERLY:
      return dayjs().startOf('quarter');
    case FREQUENCY_YEARLY:
      return dayjs().startOf('year');
    default:
      throw new Error(`Invalid prune groupBy: ${groupBy}`);
  }
};

/**
 * Returns last months backup folder name.
 *
 * @param {string} groupBy the frequency to prune the backups (monthly,
 * quarterly, yearly)
 * @returns {string} Previous month in the format of YYYY-MM or the format for
 * the previous period that matches the frequency of the groupBy.
 */
const getPreviousBackupFolder = (groupBy) => {
  switch (groupBy.toLowerCase) {
    case FREQUENCY_MONTHLY:
      return dayjs().subtract(1, 'month').format(FORMAT_MONTHLY);
    case FREQUENCY_QUARTERLY:
      return dayjs().subtract(3, 'months').format(FORMAT_QUARTERLY);
    case FREQUENCY_YEARLY:
      return dayjs().subtract(1, 'year').format(FORMAT_YEARLY);
    default:
      throw new Error(`Invalid prune frequency: ${groupBy}`);
  }
};

/**
 * Perform a backup of a domain, running or stopped.
 *
 * @param {Promise<string>} domain the domain to backup
 */
const backup = async (
  domain,
  outputDir,
  raw,
  groupBy,
) => {
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
    cwd: import.meta.dirname,
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
