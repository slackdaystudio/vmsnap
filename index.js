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

// Need to promisify exec to use async/await
export const asyncExec = util.promisify(exec);

export const logger = winston.createLogger({
  levels: winston.config.npm.levels,
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

/**
 * Main function
 */
const main = async () => {
  if (!argv.domains) {
    throw new Error('No domains specified');
  }

  if (!argv.output) {
    throw new Error('No output directory specified');
  }

  for (const domain of await parseDomains(argv.domains)) {
    const lastMonthsBackupsDir = `${argv.output}/${domain}/${getPreviousBackupFolder()}`;

    // If it's the first of the month, run a cleanup for any the bitmaps and
    // checkpoints found for the domain if pruning is flagged on.
    if (argv.prune === 'true' && dayjs().date() === 1) {
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

// Parse command line arguments
const argv = Yargs(process.argv.slice(2)).argv;

const lockfile = `${tmpdir()}/vmsnap.lock`;

// Run in a lock to prevent multiple instances from running
lock(lockfile, { retries: 10, retryWait: 10000 }, () => {
  // Check dependencies
  checkDependencies().catch((err) => {
    logger.error(err);

    exit(1);
  });

  if (argv.scrub === 'true') {
    logger.info('Scrubbing checkpoints and bitmaps');

    if (!argv.domains) {
      throw new Error('No domains specified');
    }

    parseDomains(argv.domains)
      .then(async (domains) => {
        for (const domain of domains) {
          logger.info(`  - Scrubbing domain: ${domain}`);

          await cleanupCheckpoints(domain);

          await cleanupBitmaps(domain);
        }

        exit(0);
      })
      .catch((err) => {
        logger.error(err.message);

        exit(4);
      });
  } else {
    // Run the main function
    main()
      .catch((err) => {
        logger.error(err.message);

        exit(2);
      })
      .finally(() => {
        unlock(lockfile, (err) => {
          if (err) {
            logger.error(err);
          }
        });
      });
  }
});
