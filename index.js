#!/usr/local/bin/node
import { exec } from 'child_process';
import util from 'util';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import dayjs from 'dayjs';
import Yargs from 'yargs';
import { lock } from 'lockfile';
import * as winston from 'winston';
import {
  cleanupCheckpoints,
  fetchAllDisks,
  fetchAllDomains,
} from './libs/virsh.js';
import { cleanupBitmaps } from './libs/qemu-img.js';
import {
  checkDependencies,
  getPreviousBackupFolder,
  isLastMonthsBackupCreated,
  parseArrayParam,
  releaseLock,
} from './libs/general.js';
import { backup } from './libs/libnbdbackup.js';

/**
 * This script is designed to backup KVM virtual machines using the
 * virtnbdbackup utility.  It relies on the virsh and qemu-img utilities as well
 * so please make sure you have them installed.
 *
 * Usage: node index.js --domains=<domain> --output=<output directory>
 *
 * --domains: Comma-separated list of domains to backup.  Use '*' to backup all
 * domains.
 * --output: Output directory for the backups.  Only supply the root of where
 * you want the backups to go.  The script will create a directory for each
 * domain and a subdirectory for each year/month.
 * --prune=<true|false> (Optional), this will delete the previous month's
 * backups if it's the middle of the month and the backups exist.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

/**
 * Error with the domains argument, usually indicates no domains were specified.
 */
const ERR_DOMAINS = 1;

/**
 * Error with the output directory argument, usually indicates no output
 * directory was specified or it doesn't exist.
 */
const ERR_OUTPUT_DIR = 2;

/**
 * Main error, something went wrong during the main function.
 */
const ERR_MAIN = 3;

/**
 * Requirements error, something is missing that is required for the script to
 * execute.
 */
const ERR_REQS = 4;

/**
 * Scrub error, something went wrong during the scrubbing of checkpoints and
 * bitmaps.
 */
const ERR_SCRUB = 5;

/**
 * Lock release error, something went wrong releasing the lock file.
 */
export const ERR_LOCK_RELEASE = 6;

// Need to promisify exec to use async/await
export const asyncExec = util.promisify(exec);

/**
 * The logger for the app.
 */
export const logger = winston.createLogger({
  levels: winston.config.npm.levels,
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Parse command line arguments
const argv = Yargs(process.argv.slice(2)).argv;

// Lock file for the script
export const lockfile = `${tmpdir()}/vmsnap.lock`;

/**
 * Fetches all domains found on the system.
 *
 * @returns {Promise<Array<string>} a list of all domains found on the system
 */
const fetchDomains = async () => await fetchAllDomains();

/**
 * Finds all disks for a domain.
 *
 * @param {string} domain the domain to fetch disks for
 * @returns {Promise<Array<string>>} a list of disks for the domain
 */
const fetchDisks = async (domain) => {
  return await fetchAllDisks(domain).map((d) => d[1]);
};

/**
 * Performs a backup on one or more VM domains by inspecting passed in command
 * line arguments.
 */
const main = async () => {
  if (!argv.domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  if (!argv.output) {
    throw new Error('No output directory specified', { code: ERR_OUTPUT_DIR });
  }

  for (const domain of await parseArrayParam(argv.domains, fetchDomains)) {
    const lastMonthsBackupsDir = `${argv.output}/${domain}/${getPreviousBackupFolder()}`;

    // If it's the first of the month, run a cleanup for any the bitmaps and
    // checkpoints found for the domain if pruning is flagged on.
    if (dayjs().date() === 1) {
      logger.info('First of the month, running cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(
        domain,
        async () =>
          await parseArrayParam(argv.approvedDisks, () => fetchDisks(domain)),
      );
    }

    await backup(domain, argv.output, argv.raw === 'true');

    // If it's the middle of the month, run a cleanup of the previous month's
    // backups if they exist and the prune flag is set.
    if (
      argv.prune === 'true' &&
      dayjs().date() >= 15 &&
      (await isLastMonthsBackupCreated(lastMonthsBackupsDir))
    ) {
      logger.info('Middle of the month, running cleanup');

      // Delete last months backups
      await rm(lastMonthsBackupsDir, { recursive: true, force: true });
    }
  }
};

/**
 * Scrubs off the checkpoints and bitmaps for the domains passed in.
 *
 * @returns {Promise<boolean>} true if the scrubbing was successful, false if
 * there was a failure.
 */
const scrub = async () => {
  if (!argv.domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  logger.info('Scrubbing checkpoints and bitmaps');

  let scrubbed = false;

  try {
    for (const domain of await parseArrayParam(argv.domains, fetchDomains)) {
      logger.info(`Scrubbing domain: ${domain}`);

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(
        domain,
        await parseArrayParam(
          argv.approvedDisks,
          async () => await fetchDisks(domain),
        ),
      );
    }

    scrubbed = true;
  } catch (err) {
    logger.error(err.message);

    scrubbed = false;
  }

  return scrubbed;
};

// Exit code for the script
let exitCode = 0;

// Run in a lock to prevent multiple instances from running
lock(lockfile, { retries: 10, retryWait: 10000 }, () => {
  checkDependencies().catch((err) => {
    logger.error(err);

    releaseLock(ERR_REQS);
  });

  if (argv.scrub === 'true') {
    scrub()
      .catch((err) => {
        logger.error(err.message);

        exitCode = err.code || ERR_SCRUB;
      })
      .finally(() => {
        releaseLock(exitCode);
      });
  } else {
    main()
      .catch((err) => {
        logger.error(err.message);

        exitCode = err.code || ERR_MAIN;
      })
      .finally(() => {
        releaseLock(exitCode);
      });
  }
});
