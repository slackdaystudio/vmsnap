import { access } from 'fs/promises';
import commandExists from 'command-exists';
import {
  ERR_DOMAINS,
  ERR_INVALID_SCRUB_TYPE,
  ERR_REQS,
  ERR_SCRUB,
  ERR_TOO_MANY_COMMANDS,
  logger,
} from '../vmsnap.js';
import { cleanupCheckpoints, fetchAllDomains, VIRSH } from './virsh.js';
import { cleanupBitmaps, QEMU_IMG } from './qemu-img.js';
import { BACKUP } from './libnbdbackup.js';

const SCRUB_TYPE_CHECKPOINT = 'checkpoint';

const SCRUB_TYPE_BITMAP = 'bitmap';

const SCRUB_TYPE_BOTH = 'both';

const SCRUB_TYPE_ALL = '*';

/**
 * General functions used by vmsnap.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

/**
 * Check if all dependencies are installed
 */
const checkDependencies = async () => {
  const requiredPrograms = [VIRSH, QEMU_IMG, BACKUP];

  const missingPrograms = [];

  for (const program of requiredPrograms) {
    try {
      await commandExists(program);
    } catch (error) {
      missingPrograms.push(program);
    }
  }

  if (missingPrograms.length > 0) {
    throw new Error(
      `Missing dependencies (${missingPrograms.join(', ')})`,
      ERR_REQS,
    );
  }
};

/**
 * Checks the command line arguments to ensure only one command is being run.
 *
 * @param {object} options the command line options to destructure for status,
 * scrub, and backup.
 */
const checkCommand = ({ status, scrub, backup }) => {
  let commandCount = 0;

  if (status) {
    ++commandCount;
  }

  if (scrub) {
    ++commandCount;
  }

  if (backup) {
    ++commandCount;
  }

  if (commandCount > 1) {
    throw new Error(
      'Only one command can be run at a time',
      ERR_TOO_MANY_COMMANDS,
    );
  }
};

/**
 * Parses a string parameter for an array.
 *
 * @param {string} param the string param to parse for an array
 * @param {function} fetchAll what to call to fetch all the items
 * @returns {Promise<Array<string>>} the parsed array
 */
const parseArrayParam = async (param, fetchAll = async () => []) => {
  let parsed = [];

  if (param === undefined || typeof param !== 'string') {
    return parsed;
  }

  if (param.indexOf(',') > -1) {
    parsed = param.split(',');
  } else if (param === '*') {
    parsed = await fetchAll();
  } else if (typeof param === 'string') {
    parsed.push(param);
  } else {
    throw new Error(`Invalid parameter: ${param}`);
  }

  return parsed;
};

/**
 * Checks the local file system to see if the file exists.
 *
 * @param {string} path the path to the file to check
 * @returns {Promise<boolean>} true if the file exists, false otherwise
 */
const fileExists = async (path) => {
  try {
    await access(path);

    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Scrubs off the checkpoints and bitmaps for the domains passed in.
 *
 * @param {string} domains the domains to scrub checkpoints and bitmaps for
 * @returns {Promise<boolean>} true if the scrubbing was successful, false if
 * there was a failure.
 */
const scrubCheckpointsAndBitmaps = async ({
  domains,
  checkpointName,
  scrubType,
}) => {
  if (!domains) {
    throw new Error('No domains specified', { code: ERR_DOMAINS });
  }

  logger.info('Scrubbing checkpoints and bitmaps');

  let scrubbed = false;

  try {
    for (const domain of await parseArrayParam(domains, fetchAllDomains)) {
      logger.info(`Scrubbing domain: ${domain}`);

      if (scrubType === SCRUB_TYPE_CHECKPOINT) {
        await cleanupCheckpoints(domain, checkpointName);
      } else if (scrubType === SCRUB_TYPE_BITMAP) {
        await cleanupBitmaps(domain, checkpointName);
      } else if (scrubType === SCRUB_TYPE_BOTH) {
        await cleanupCheckpoints(domain, checkpointName);

        await cleanupBitmaps(domain, checkpointName);
      } else if (scrubType === '*') {
        await cleanupCheckpoints(domain);

        await cleanupBitmaps(domain);
      } else {
        logger.error('No scrub type specified', {
          code: ERR_INVALID_SCRUB_TYPE,
        });
      }
    }

    scrubbed = true;
  } catch (err) {
    logger.error(err.message, { code: ERR_SCRUB });

    scrubbed = false;
  }

  return scrubbed;
};

/**
 * Returns the key corresponding to a given value in a map.
 *
 * @param {Map<any, any>} map - A map to search for the key by value.
 * @param {any} value - The value to search for in the map.
 * @returns {any} The key of the map corresponding to the value, or undefined
 * if not found.
 */
const findKeyByValue = (map, value) => {
  for (const [key, val] of map.entries()) {
    if (val === value) {
      return key;
    }
  }

  return undefined;
};

export {
  checkDependencies,
  checkCommand,
  fileExists,
  findKeyByValue,
  parseArrayParam,
  scrubCheckpointsAndBitmaps,
};
