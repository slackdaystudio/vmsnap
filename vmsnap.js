#!/usr/bin/env node
import process, { exit } from 'process';
import { exec } from 'child_process';
import util from 'util';
import { tmpdir } from 'os';
import { sep } from 'path';
import Yargs from 'yargs';
import { lock, unlock } from 'lockfile';
import * as winston from 'winston';
import { consoleFormat } from 'winston-console-format';
import yoctoSpinner from 'yocto-spinner';
import {
  checkCommand,
  checkDependencies,
  scrubCheckpointsAndBitmaps,
} from './libs/general.js';
import { performBackup } from './libs/libnbdbackup.js';
import { printStatusCheck, SCREEN_SIZE } from './libs/print.js';
import { setLibvirtUri } from './libs/virsh.js';

/**
 * This script is designed to backup KVM virtual machines using the
 * virtnbdbackup utility.  It relies on the virsh and qemu-img utilities as well
 * so please make sure you have them installed.
 *
 * Usage: node vmsnap.js --domains=<domain> --output=<output directory>
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

// Error with the domains argument, usually indicates no domains were specified.
export const ERR_DOMAINS = 1;

// Error with the output directory argument, usually indicates no output
// directory was specified.
export const ERR_OUTPUT_DIR = 2;

// Main error, something went wrong during the main function.
export const ERR_MAIN = 3;

// Requirements error, something is missing that is required for the script to
// operate.
export const ERR_REQS = 4;

// Scrub error, something went wrong during the scrubbing of checkpoints and
// bitmaps.
export const ERR_SCRUB = 5;

// Lock release error, something went wrong releasing the lock.
export const ERR_LOCK_RELEASE = 6;

// More than one command was specified.
export const ERR_TOO_MANY_COMMANDS = 7;

// Invalid scrub type was specified.
export const ERR_INVALID_SCRUB_TYPE = 8;

// A spinnner for long running tasks
export const spinner = yoctoSpinner();

// Lock file for the script
const lockfile = `${tmpdir()}${sep}vmsnap.lock`;

// Need to promisify exec to use async/await
export const asyncExec = util.promisify(exec);

// Parse command line arguments
const argv = Yargs(process.argv.slice(2)).argv;

// Set the libvirt connection URI if provided (e.g., qemu:///system or qemu:///session)
if (argv.connect) {
  setLibvirtUri(argv.connect);
}

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

// Exit code for the script
let exitCode = 0;

// Run with a lock to prevent multiple instances from running
lock(lockfile, { retries: 10, retryWait: 10000 }, async (lockErr) => {
  // Handle lock acquisition failure
  if (lockErr) {
    logger.error(`Failed to acquire lock: ${lockErr.message}`);
    exit(ERR_MAIN);
    return;
  }

  try {
    await checkDependencies();

    if (argv.verbose) {
      logger.info('Dependencies are installed');
    }

    checkCommand(argv);

    if (argv.scrub) {
      await scrubCheckpointsAndBitmaps(argv);
    } else if (argv.backup) {
      await performBackup(argv);
    } else {
      await printStatusCheck(argv);
    }
  } catch (err) {
    spinner.stop();

    logger.error(err.message);

    // Ensure err.code is a number, otherwise use ERR_MAIN
    exitCode = typeof err.code === 'number' ? err.code : ERR_MAIN;
  } finally {
    spinner.stop();

    if (exitCode === undefined) {
      logger.info('No exit code provided for lock release');
    }

    unlock(lockfile, (err) => {
      if (err) {
        logger.error(err);

        exitCode = ERR_LOCK_RELEASE;
      }

      exit(exitCode !== undefined ? exitCode : ERR_MAIN);
    });
  }
});
