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
 * Creates an error with a code property set for proper exit code handling.
 *
 * @param {string} message the error message
 * @param {number} code the error code
 * @returns {Error} an error with the code property set
 */
const createError = (message, code) => {
  const err = new Error(message);
  err.code = code;
  return err;
};

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
    throw createError(
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
    throw createError(
      'Only one command can be run at a time',
      ERR_TOO_MANY_COMMANDS,
    );
  }
};

/**
 * Converts a glob/wildcard pattern to a regular expression.
 *
 * @param {string} pattern the glob pattern to convert
 * @returns {RegExp} the regular expression
 */
const globToRegex = (pattern) => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
    .replace(/\*/g, '.*') // Convert * to .*
    .replace(/\?/g, '.'); // Convert ? to .
  return new RegExp(`^${escaped}$`);
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
    // Handle comma-separated list - each item may contain wildcards
    const items = param.split(',');
    const allItems = await fetchAll();

    for (const item of items) {
      if (item.includes('*') || item.includes('?')) {
        // Item contains wildcards - filter all items against the pattern
        const regex = globToRegex(item);
        const matches = allItems.filter((d) => regex.test(d));
        parsed.push(...matches);
      } else {
        // No wildcards - add as-is
        parsed.push(item);
      }
    }

    // Remove duplicates
    parsed = [...new Set(parsed)];
  } else if (param === '*') {
    parsed = await fetchAll();
  } else if (param.includes('*') || param.includes('?')) {
    // Handle wildcard pattern like "vmsnap-test-*"
    const allItems = await fetchAll();
    const regex = globToRegex(param);
    parsed = allItems.filter((d) => regex.test(d));
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
    throw createError('No domains specified', ERR_DOMAINS);
  }

  logger.info('Scrubbing checkpoints and bitmaps');

  let scrubbed = false;

  const parsedDomains = await parseArrayParam(domains, fetchAllDomains);

  if (parsedDomains.length === 0) {
    throw createError(`No matching domains found for: ${domains}`, ERR_DOMAINS);
  }

  try {
    for (const domain of parsedDomains) {
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
        throw createError(
          `Invalid scrub type: ${scrubType}`,
          ERR_INVALID_SCRUB_TYPE,
        );
      }
    }

    scrubbed = true;
  } catch (err) {
    // Re-throw errors with proper codes
    if (err.code) {
      throw err;
    }
    throw createError(err.message, ERR_SCRUB);
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
  createError,
  fileExists,
  findKeyByValue,
  parseArrayParam,
  scrubCheckpointsAndBitmaps,
};
