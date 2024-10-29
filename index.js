#!/usr/local/bin/node
import { exit } from 'process';
import { exec } from 'child_process';
import util from 'util';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import dayjs from 'dayjs';
import Yargs from 'yargs';
import { lock, unlock } from 'lockfile';
import * as winston from 'winston';
import { cleanupCheckpoints } from './libs/virsh.js';
import { cleanupBitmaps } from './libs/qemu-img.js';
import {
  checkDependencies,
  getPreviousBackupFolder,
  isLastMonthsBackupCreated,
  parseDomains,
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
const ERR_DOMAINS = 0;

/**
 * Error with the output directory argument, usually indicates no output
 * directory was specified or it doesn't exist.
 */
const ERR_OUTPUT_DIR = 1;

/**
 * Main error, something went wrong during the main function.
 */
const ERR_MAIN = 2;

/**
 * Requirements error, something is missing that is required for the script to
 * execute.
 */
const ERR_REQS = 3;

/**
 * Scrub error, something went wrong during the scrubbing of checkpoints and
 * bitmaps.
 */
const ERR_SCRUB = 4;

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
const lockfile = `${tmpdir()}/vmsnap.lock`;

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

  for (const domain of await parseDomains(argv.domains)) {
    const lastMonthsBackupsDir = `${argv.output}/${domain}/${getPreviousBackupFolder()}`;

    // If it's the first of the month, run a cleanup for any the bitmaps and
    // checkpoints found for the domain if pruning is flagged on.
    if (dayjs().date() === 1) {
      logger.info('First of the month, running cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    await backup(domain, argv.output);

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

  let scrubbed = false;

  try {
    for (const domain of await parseDomains(argv.domains)) {
      logger.info(`  - Scrubbing domain: ${domain}`);

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    scrubbed = true;
  } catch (err) {
    logger.error(err.message);

    scrubbed = false;
  }

  return scrubbed;
};

// Run in a lock to prevent multiple instances from running
lock(lockfile, { retries: 10, retryWait: 10000 }, () => {
  /**
   * Release the lock created by the execution of the script.
   */
  const releaseLock = () => {
    unlock(lockfile, (err) => {
      if (err) {
        logger.error(err);
      }
    });
  };

  // Check dependencies
  checkDependencies().catch((err) => {
    logger.error(err);

    releaseLock();

    exit(ERR_REQS);
  });

  if (argv.scrub === 'true') {
    logger.info('Scrubbing checkpoints and bitmaps');

    scrub()
      .catch((err) => {
        logger.error(err.message);

        exit(ERR_SCRUB);
      })
      .finally(() => {
        releaseLock();
      });
  } else {
    main()
      .catch((err) => {
        logger.error(err.message);

        exit(ERR_MAIN);
      })
      .finally(() => {
        releaseLock();
      });
  }
});
