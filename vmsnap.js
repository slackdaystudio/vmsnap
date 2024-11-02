#!/usr/bin/env node
import { exec } from 'child_process';
import util from 'util';
import { EOL, tmpdir } from 'os';
import { sep } from 'path';
import { rm } from 'fs/promises';
import dayjs from 'dayjs';
import Yargs from 'yargs';
import { lock } from 'lockfile';
import * as winston from 'winston';
import { consoleFormat } from 'winston-console-format';
import * as YAML from 'json-to-pretty-yaml';
import yoctoSpinner from 'yocto-spinner';
import { cleanupCheckpoints, fetchAllDomains } from './libs/virsh.js';
import { cleanupBitmaps } from './libs/qemu-img.js';
import {
  checkCommand,
  checkDependencies,
  frame,
  getPreviousBackupFolder,
  isLastMonthsBackupCreated,
  isThisMonthsBackupCreated,
  parseArrayParam,
  printStatuses,
  releaseLock,
  status,
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

// The screen size for the logger.
export const SCREEN_SIZE = 80;

// The YAML type
const TYPE_YAML = 'YAML';

// The JSON type
const TYPE_JSON = 'JSON';

// Error with the domains argument, usually indicates no domains were specified.
const ERR_DOMAINS = 1;

// Error with the output directory argument, usually indicates no output
// directory was specified.
const ERR_OUTPUT_DIR = 2;

// Main error, something went wrong during the main function.
export const ERR_MAIN = 3;

// Requirements error, something is missing that is required for the script to
// operate.
const ERR_REQS = 4;

// Scrub error, something went wrong during the scrubbing of checkpoints and
// bitmaps.
const ERR_SCRUB = 5;

// Lock release error, something went wrong releasing the lock file.
export const ERR_LOCK_RELEASE = 6;

// A spinnner for long running tasks
export const spinner = yoctoSpinner();

// Lock file for the script
export const lockfile = `${tmpdir()}${sep}vmsnap.lock`;

// Need to promisify exec to use async/await
export const asyncExec = util.promisify(exec);

// Parse command line arguments
const argv = Yargs(process.argv.slice(2)).argv;

// The formats for the logger
let formats = [];

// The console format options
let consoleFormatOptions = [winston.format.printf((info) => `${info.message}`)];

// If the verbose flag is set, add the colorize and pretty print options
if (argv.verbose) {
  // The formats for the logger
  formats = [
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
    winston.format.ms(),
  ];

  consoleFormatOptions = [
    winston.format.colorize(),
    winston.format.splat({ depth: Infinity }),
    consoleFormat({
      showMeta: true,
      metaStrip: ['timestamp', 'service'],
      inspectOptions: {
        depth: Infinity,
        colors: true,
        maxArrayLength: Infinity,
        breakLength: SCREEN_SIZE,
        compact: Infinity,
      },
    }),
  ];
}

// The logger for the app.
export const logger = winston.createLogger({
  format: winston.format.combine(...formats),
  defaultMeta: { service: 'vmsnap' },
  transports: [
    new winston.transports.Console({
      levels: winston.config.cli.levels,
      silent: false,
      format: winston.format.combine(...consoleFormatOptions),
    }),
  ],
});

/**
 * Performs a backup on one or more VM domains by inspecting passed in command
 * line arguments.
 */
const performBackup = async () => {
  if (!argv.domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  if (!argv.output) {
    throw new Error('No output directory specified', { code: ERR_OUTPUT_DIR });
  }

  for (const domain of await parseArrayParam(argv.domains, fetchDomains)) {
    const lastMonthsBackupsDir = `${argv.output}${sep}${domain}${sep}${getPreviousBackupFolder()}`;

    const todaysDay = dayjs().date();

    // If it's the first of the month, run a cleanup for any the bitmaps and
    // checkpoints found for the domain.
    if (
      todaysDay >= 1 &&
      todaysDay <= 14 &&
      !(await isThisMonthsBackupCreated(domain, argv.output))
    ) {
      logger.info('Creating a new backup directory, running bitmap cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    await backup(domain, argv.output, argv.raw);

    // If it's the middle of the month, run a cleanup of the previous month's
    // backups if they exist and the prune flag is set.
    if (
      argv.prune === 'true' &&
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
 * Scrubs off the checkpoints and bitmaps for the domains passed in.
 *
 * @returns {Promise<boolean>} true if the scrubbing was successful, false if
 * there was a failure.
 */
const scrubCheckpointsAndBitmaps = async () => {
  if (!argv.domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  logger.info('Scrubbing checkpoints and bitmaps');

  let scrubbed = false;

  try {
    for (const domain of await parseArrayParam(argv.domains, fetchAllDomains)) {
      logger.info(`Scrubbing domain: ${domain}`);

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

/**
 * Serializes the statuses and prints them to the console.
 *
 * @param {Array} statuses an array of statuses to print
 */
const printSerializedStatus = (statuses) => {
  let serialized;
  let type = TYPE_JSON;

  if (argv.yml || argv.yaml) {
    serialized = YAML.stringify(statuses);

    type = TYPE_YAML;
  } else {
    serialized = argv.machine
      ? JSON.stringify(statuses)
      : JSON.stringify(statuses, undefined, 2);
  }

  if (argv.machine) {
    logger.info(serialized);
  } else {
    logger.info(frame(type, serialized));
  }
};

// Exit code for the script
let exitCode = 0;

// Run with a lock to prevent multiple instances from running
lock(lockfile, { retries: 10, retryWait: 10000 }, async () => {
  try {
    await checkDependencies();

    if (argv.verbose) {
      logger.info('Dependencies are installed');
    }

    checkCommand(argv);

    if (argv.scrub) {
      await scrubCheckpointsAndBitmaps();
    } else if (argv.backup) {
      await performBackup();
    } else {
      if (argv.verbose) {
        logger.info('Starting status check...');
      }

      spinner.start(`Querying for domains...${EOL}`);

      const statuses = await status(
        argv.domains || '*',
        argv.output,
        argv.pretty,
      );

      spinner.stop();

      if (argv.yml || argv.yaml || argv.json) {
        printSerializedStatus(statuses);
      } else {
        printStatuses(statuses);
      }
    }
  } catch (err) {
    logger.error(err.message);

    exitCode = err.code || ERR_MAIN;
  } finally {
    releaseLock(exitCode);
  }
});
