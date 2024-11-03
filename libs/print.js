import { EOL, machine } from 'os';
import chalk from 'chalk';
import prettyBytes from 'pretty-bytes';
import * as YAML from 'json-to-pretty-yaml';
import { spinner, logger, TYPE_JSON, TYPE_YAML } from '../vmsnap.js';
import { status, STATUS_OK, STATUSES } from './general.js';

// The screen size for the logger.
export const SCREEN_SIZE = 80;

/**
 * 
 * 
 * @param {Object} args the command line arguments (domains, verbose, output, 
 * pretty, machine, yml, yaml, json) 
 */
const printStatusCheck = async ({
  domains,
  verbose,
  output,
  pretty,
  machine,
  yml = false,
  yaml = false,
  json = false,
}) => {
  if (verbose) {
    logger.info('Starting status check...');
  }

  spinner.start(`Querying for domains...${EOL}`);

  const statuses = await status(domains || '*', output, pretty);

  spinner.stop();

  if (yml || yaml || json) {
    printSerializedStatus(statuses, yml, yaml, machine);
  } else {
    printStatuses(statuses);
  }
};

/**
 * Will print the size in bytes or a pretty formatted string like 25 GB or 1.5
 * MB
 *
 * @param {number} size the bytes to print
 * @returns {number|string} the size in bytes or a pretty formatted string
 */
const printSize = (size, pretty = false) => (pretty ? prettyBytes(size) : size);

/**
 * Prints the status of the specified domains.
 *
 * @param {Array<object>} statuses the statuses to print
 * @param {boolean} pretty whether to print the statuses with formatted disk
 * sizes or not.
 */
const printStatuses = (statuses) => {
  for (const domain of Object.keys(statuses)) {
    const status = statuses[domain];

    logger.info(`Status for ${chalk.bold.magentaBright(domain)}:`);

    const statusColor =
      status.overallStatus === STATUS_OK ? 'greenBright' : 'yellowBright';

    logger.info(
      `  Overall status: ${chalk.bold[statusColor](STATUSES.get(status.overallStatus))}`,
    );

    if (!status.checkpoints || status.checkpoints.length === 0) {
      logger.info(`  No checkpoints found for ${domain}`);
    } else {
      logger.info(`  Checkpoints found for ${domain}:`);

      for (const checkpoint of status.checkpoints) {
        logger.info(`    ${checkpoint}`);
      }
    }

    if (status.disks.length === 0) {
      logger.info(`  No eligible disks found for ${domain}`);
    } else {
      logger.info(`  Eligible disks found for ${domain}:`);

      for (const disk of status.disks) {
        logger.info(`    ${disk.disk}`);
        logger.info(`      Virtual size: ${disk.virtualSize}`);
        logger.info(`      Actual size: ${disk.actualSize}`);

        if (disk.bitmaps.length === 0) {
          logger.info(`      No bitmaps found for ${disk.disk}`);
        } else {
          logger.info(`      Bitmaps found for ${disk.disk}:`);

          for (const bitmap of disk.bitmaps) {
            logger.info(`          ${bitmap}`);
          }
        }
      }
    }

    if (status.backupDirStats) {
      logger.info(`  Backup directory stats for ${domain}:`);
      logger.info(`    Path: ${status.backupDirStats.path}`);
      logger.info(`    Total files: ${status.backupDirStats.totalFiles}`);
      logger.info(`    Total size: ${status.backupDirStats.totalSize}`);
      logger.info(`    Checkpoints: ${status.backupDirStats.checkpoints}`);
    }
  }
};

/**
 * Frames text with a prefix and a line of hyphens.
 *
 * @param {string} prefix The prefix to display before the frame
 * @param {*} text The text to display in the frame
 * @returns {string} The framed text
 */
const frame = (prefix, text) => {
  const line = '-'.repeat(SCREEN_SIZE);

  return `${prefix}:${EOL}${line}${EOL}${text}${EOL}${line}`;
};

/**
 * Serializes the statuses and prints them to the console.
 *
 * @param {Array} statuses an array of statuses to print
 */
const printSerializedStatus = (statuses, yml, yaml, machine) => {
  let serialized;
  let type = TYPE_JSON;

  if (yml || yaml) {
    serialized = YAML.stringify(statuses);

    type = TYPE_YAML;
  } else {
    serialized = JSON.stringify(statuses, undefined, machine ? 0 : 2);
  }

  if (machine) {
    logger.info(serialized);
  } else {
    logger.info(frame(type, serialized));
  }
};

export { printStatusCheck, printSize };
