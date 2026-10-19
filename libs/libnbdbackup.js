import { sep } from 'path';
import { spawn } from 'child_process';
import { readdir, rm } from 'fs/promises';
import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat.js';
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js';
import dayOfYear from 'dayjs/plugin/dayOfYear.js';
import {
  logger,
  ERR_BACKUP,
  ERR_DOMAINS,
  ERR_GROUPBY,
  ERR_OUTPUT_DIR,
} from '../vmsnap.js';
import { cleanupCheckpoints, domainExists, isDomainRunning, fetchAllDomains } from './virsh.js';
import { createError, fileExists, parseArrayParam } from './general.js';
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

// The day of the year the second half of a bi-annual period starts on.
const BI_ANNUAL_SECOND_HALF_DAY = 180;

// Folder prefix for incremental backup chains.
export const BACKUP_FOLDER_PREFIX = 'vmsnap-backup';

// Folder prefix for standalone copies made with --copy.
export const COPY_FOLDER_PREFIX = 'vmsnap-copy';

/**
 * Returns the current months backup folder name in the format for the given
 * groupBy.
 *
 * @param {string} groupBy how to group the backups by on disk (month, quarter,
 * bi-annual, year)
 * @param {boolean} current true if the current months folder will be returned,
 * false will return last months folder.
 * @param {string} prefix the folder name prefix (backup chain or copy)
 * @returns {string} the current months backup folder name
 */
const getBackupFolder = (
  groupBy = FREQUENCY_MONTHLY,
  current = true,
  prefix = BACKUP_FOLDER_PREFIX,
) => {
  let lastFolder;

  switch (groupBy) {
    case FREQUENCY_QUARTERLY:
      lastFolder = current
        ? dayjs().format(FORMAT_QUARTERLY)
        : dayjs().subtract(3, 'months').format(FORMAT_QUARTERLY);
      break;
    case FREQUENCY_BI_ANNUALLY:
      let yearPart = dayjs().dayOfYear() >= BI_ANNUAL_SECOND_HALF_DAY ? 2 : 1;

      if (!current) {
        yearPart = yearPart === 1 ? 2 : 1;
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
      break;
    default:
      return undefined;
  }

  return `${prefix}-${groupBy}ly-${lastFolder}`;
};

/**
 * Performs a backup on one or more VM domains by inspecting passed in command
 * line arguments.
 *
 * @param {Object} args the command line arguments (domans, output, raw, prune,
 * copy, force)
 */
const performBackup = async ({
  domains,
  output,
  raw,
  groupBy = FREQUENCY_MONTHLY,
  prune,
  connect,
  socketfile,
  copy,
  force,
}) => {
  if (!domains) {
    throw createError('No domains specified', ERR_DOMAINS);
  }

  if (!output) {
    throw createError('No output directory specified', ERR_OUTPUT_DIR);
  }

  const parsedDomains = await parseArrayParam(domains, fetchAllDomains);

  if (parsedDomains.length === 0) {
    throw createError(`No matching domains found for: ${domains}`, ERR_DOMAINS);
  }

  if (!PRUNING_FREQUENCIES.includes(groupBy)) {
    throw createError(
      `Invalid groupBy: ${groupBy} (expected one of: ${PRUNING_FREQUENCIES.join(', ')})`,
      ERR_GROUPBY,
    );
  }

  // Domains starting a new backup chain.  Copies never touch checkpoints, so
  // they never need a cleanup.
  const newChains = new Set();

  if (!copy) {
    for (const domain of parsedDomains) {
      if (await isCleanupRequired(domain, groupBy, output)) {
        newChains.add(domain);
      }
    }
  }

  if (!force) {
    await checkGroupByMatches([...newChains], groupBy, output);
  }

  const prefix = copy ? COPY_FOLDER_PREFIX : BACKUP_FOLDER_PREFIX;

  const failedDomains = [];

  for (const domain of parsedDomains) {
    if (newChains.has(domain)) {
      logger.info('Creating a new backup directory, running bitmap cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    // Keep backing up the remaining domains, but never prune the old backups
    // of a domain whose current backup failed.
    if (
      !(await backup(domain, output, raw, groupBy, connect, socketfile, copy))
    ) {
      failedDomains.push(domain);

      continue;
    }

    if (await isPruningRequired(domain, groupBy, prune, output, prefix)) {
      logger.info(
        'Middle of the current backup window, running a cleanup on old backups',
      );

      // Delete last months backups
      await pruneLastMonthsBackups(domain, groupBy, output, prefix);
    }
  }

  if (failedDomains.length > 0) {
    throw createError(
      `Backup failed for: ${failedDomains.join(', ')}`,
      ERR_BACKUP,
    );
  }
};

/**
 * Finds the groupBy of every backup chain on disk for a domain.
 *
 * @param {string} domain the domain to look up
 * @param {string} path the full backup directory path
 * @returns {Promise<Set<string>>} the groupBy values found
 */
const findExistingGroupBys = async (domain, path) => {
  const found = new Set();

  let entries;

  try {
    entries = await readdir(`${path}${sep}${domain}`);
  } catch {
    return found;
  }

  for (const entry of entries) {
    for (const frequency of PRUNING_FREQUENCIES) {
      if (entry.startsWith(`${BACKUP_FOLDER_PREFIX}-${frequency}ly-`)) {
        found.add(frequency);
      }
    }
  }

  return found;
};

/**
 * Refuses to start a new backup chain for a domain whose existing backups use
 * a different groupBy.  Checkpoints belong to the domain rather than a backup
 * folder, so starting the new chain would delete the checkpoints the existing
 * chain needs for its next incremental backup.
 *
 * @param {Array<string>} domains the domains starting a new backup chain
 * @param {string} groupBy the groupBy of this run
 * @param {string} path the full backup directory path
 */
const checkGroupByMatches = async (domains, groupBy, path) => {
  const mismatches = [];

  for (const domain of domains) {
    const existing = await findExistingGroupBys(domain, path);

    if (existing.size > 0 && !existing.has(groupBy)) {
      mismatches.push(`${domain} (${[...existing].join(', ')})`);
    }
  }

  if (mismatches.length > 0) {
    throw createError(
      `Existing backups use a different groupBy than ${groupBy}: ${mismatches.join(', ')}. ` +
        `Pass the matching --groupBy, or --force to start a new ${groupBy} chain, which deletes the checkpoints of the existing one`,
      ERR_GROUPBY,
    );
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
 * @param {string} prefix the folder name prefix (backup chain or copy)
 * @returns true if pruning is required, false otherwise
 */
const isPruningRequired = async (
  domain,
  groupBy,
  pruneFrequency,
  path,
  prefix = BACKUP_FOLDER_PREFIX,
) => {
  if (pruneFrequency === false) {
    return false; // No pruning required
  }

  // If the window is not found, assume no pruning is required.
  if (!PRUNING_FREQUENCIES.includes(groupBy)) {
    logger.warn(`Invalid groupBy: ${groupBy}.  Pruning disabled`);

    return false;
  }

  const previousBackupFolder = getBackupFolder(groupBy, false, prefix);

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
 * groupBy param.
 *
 * @param {string} domain the domain to prune backups for
 * @param {*} groupBy how often to prune the backups (monthly, quarterly,
 * yearly)
 * @param {string} path the full backup directory path
 * @param {string} prefix the folder name prefix (backup chain or copy)
 */
const pruneLastMonthsBackups = async (
  domain,
  groupBy,
  path,
  prefix = BACKUP_FOLDER_PREFIX,
) => {
  const previousBackupFolder = getBackupFolder(groupBy, false, prefix);

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
  // The start of the current half of the year, matching the p1/p2 folders
  if (groupBy === FREQUENCY_BI_ANNUALLY) {
    const startOfYear = dayjs().startOf(FREQUENCY_YEARLY);

    return dayjs().dayOfYear() >= BI_ANNUAL_SECOND_HALF_DAY
      ? startOfYear.dayOfYear(BI_ANNUAL_SECOND_HALF_DAY)
      : startOfYear;
  }
  
  if (PRUNING_FREQUENCIES.includes(groupBy)) {
    return dayjs().startOf(groupBy);
  }

  return dayjs().startOf(FREQUENCY_MONTHLY);
};

/**
 * Perform a backup of a domain, running or stopped.
 *
 * @param {string} domain the domain to backup
 * @param {string} outputDir the output directory for the backup
 * @param {boolean} raw whether to use raw format
 * @param {string} groupBy the grouping frequency
 * @param {string|undefined} connect the libvirt connection URI
 * @param {string|undefined} socketfile the socket file path for NBD server
 * @param {boolean} copy true to take a standalone copy instead of a backup in
 * the incremental chain
 * @returns {Promise<boolean>} false if virtnbdbackup failed, true otherwise
 */
const backup = async (
  domain,
  outputDir,
  raw,
  groupBy,
  connect,
  socketfile,
  copy = false,
) => {
  if (!(await domainExists(domain))) {
    logger.warn(`${domain} does not exist`);

    return true;
  }

  const targetDir = `${outputDir}${sep}${domain}${sep}${getBackupFolder(
    groupBy,
    true,
    copy ? COPY_FOLDER_PREFIX : BACKUP_FOLDER_PREFIX,
  )}`;

  // virtnbdbackup refuses to copy into a folder that already holds a copy, so
  // there is one copy per period.
  if (copy && (await hasBackupData(targetDir))) {
    logger.info(`A copy of ${domain} already exists for this period, skipping`);

    return true;
  }

  const commandOpts = [
    '--noprogress',
    '-d',
    domain,
    '-l',
    copy ? 'copy' : 'auto',
    '-o',
    targetDir,
  ];

  if (raw) {
    commandOpts.push('--raw');
  }

  if (connect) {
    commandOpts.push('-U', connect);
  }

  // Only override the NBD socket path when asked to.  QEMU creates this socket,
  // so on AppArmor hosts it must be allowed by the libvirt-qemu profile.  The
  // virtnbdbackup default (/var/tmp/virtnbdbackup.*) is the path its docs
  // provide an AppArmor rule for.
  if (socketfile) {
    commandOpts.push('-f', socketfile);
  }

  // Auto-detect if domain is offline and use -S flag to enable checkpoint
  // creation.  Copies don't use checkpoints, and can read offline disks as-is.
  const isRunning = copy || (await isDomainRunning(domain));
  if (!isRunning) {
    logger.info(`${domain} is offline, starting in paused state for checkpoint backup`);
    commandOpts.push('-S');
  }

  const child = spawn(BACKUP, commandOpts, {
    uid: process.getuid(),
    gid: process.getgid(),
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
  return new Promise((resolve) => {
    child.on('error', (err) => {
      logger.error(`Backup for ${domain} failed to start: ${err.message}`);

      resolve(false);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Backup for ${domain} failed with code ${code}`);

        resolve(false);

        return;
      }

      resolve(true);
    });
  });
};

/**
 * Checks whether a backup folder already holds backup data, using the same
 * rule as virtnbdbackup (any *.data or *.data.partial file).
 *
 * @param {string} dir the backup folder
 * @returns {Promise<boolean>} true if the folder holds backup data
 */
const hasBackupData = async (dir) => {
  try {
    return (await readdir(dir)).some((entry) => entry.includes('.data'));
  } catch {
    return false;
  }
};

export { getBackupFolder, performBackup };
