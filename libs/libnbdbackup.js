import { sep } from 'path';
import { spawn } from 'child_process';
import { rm } from 'fs/promises';
import dayjs from 'dayjs';
import { logger } from '../vmsnap.js';
import { domainExists, fetchAllDomains } from './virsh.js';
import {
  getPreviousBackupFolder,
  isLastMonthsBackupCreated,
  isThisMonthsBackupCreated,
  getBackupFolder,
  parseArrayParam,
} from './general.js';

/**
 * Our functions for interfacing with the virtnbdbackup utility.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

export const BACKUP = 'virtnbdbackup';

/**
 * Performs a backup on one or more VM domains by inspecting passed in command
 * line arguments.
 *
 * @param {Object} args the command line arguments (domans, output, raw, prune)
 */
const performBackup = async ({ domains, output, raw, prune }) => {
  if (!domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  if (!output) {
    throw new Error('No output directory specified', { code: ERR_OUTPUT_DIR });
  }

  for (const domain of await parseArrayParam(domains, fetchAllDomains)) {
    const lastMonthsBackupsDir = `${output}${sep}${domain}${sep}${getPreviousBackupFolder()}`;

    const todaysDay = dayjs().date();

    // If it's the first of the month, run a cleanup for any the bitmaps and
    // checkpoints found for the domain.
    if (
      todaysDay >= 1 &&
      todaysDay <= 14 &&
      !(await isThisMonthsBackupCreated(domain, output))
    ) {
      logger.info('Creating a new backup directory, running bitmap cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    await backup(domain, output, raw);

    // If it's the middle of the month, run a cleanup of the previous month's
    // backups if they exist and the prune flag is set.
    if (
      prune === 'true' &&
      todaysDay >= 15 &&
      (await isLastMonthsBackupCreated(lastMonthsBackupsDir))
    ) {
      logger.info('Middle of the month, running cleanup');

      // Delete last months backups
      await rm(lastMonthsBackupsDir, { recursive: true, force: true });
    }
  }
};

/**
 * Perform a backup of a domain, running or stopped.
 *
 * @param {Promise<string>} domain the domain to backup
 */
const backup = async (domain, outputDir, raw = false) => {
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
    `${outputDir}${sep}${domain}${sep}${getBackupFolder()}`,
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

export { performBackup };
