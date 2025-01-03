import { EOL } from 'os';
import { asyncExec } from '../vmsnap.js';
import { logger } from '../vmsnap.js';

/**
 * The virsh command functions.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

export const VIRSH = 'virsh';

export const CHECKPOINT_REGEX = /^virtnbdbackup\.[0-9]*$/;

/**
 * Check if a domain exists on the host system.
 *
 * @param {string} domain the name of the domain
 * @returns {Promise<boolean>} True if domain exists, false otherwise
 */
const domainExists = async (domain) => {
  // Check if domain name contains invalid characters
  // https://bugs.launchpad.net/ubuntu/+source/libvirt/+bug/672948
  if (/^[A-Za-z0-9_\.\+\-&:/]*$/.test(domain) === false) {
    logger.error(`Domain ${domain} contains invalid characters`);

    return false;
  }

  const command = [VIRSH, 'domstate', domain];

  try {
    await asyncExec(command.join(' '));

    return true;
  } catch (error) {
    return false;
  }
};

/**
 * List all domains on the host system.
 *
 * @returns {Promise<Array<string>>} List of all domains
 */
const fetchAllDomains = async () => {
  const command = [VIRSH, 'list', '--all', '--name'];

  const { stdout, stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return stdout.split(EOL).filter((d) => d.length > 0);
};

/**
 * Returns a list of checkpoints for a given domain.
 *
 * @param {string} domain the domain to find checkpoints for
 * @returns {Promise<Array<string>} a list of checkpoints for the domain
 */
const findCheckpoints = async (domain) => {
  const command = [VIRSH, 'checkpoint-list', domain, '--name'];

  const { stdout, stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return stdout.split(EOL).filter((c) => c.trim() !== '');
};

/**
 * Removes all checkpoints from a given domain.
 *
 * @param {string} domain the domain to cleanup checkpoints for
 */
const cleanupCheckpoints = async (domain, checkpointName = undefined) => {
  const checkpoints = await findCheckpoints(domain);

  if (checkpoints.length === 0) {
    return;
  }

  for (const checkpoint of checkpoints) {
    // Adding just in case we have a checkpoint that isn't ours.  Not sure if 
    // this is possible, but better safe than sorry.
    if (CHECKPOINT_REGEX.test(checkpoint) === false) {
      continue;
    } 
    
    // If we have a checkpoint name and it doesn't match, skip it
    if (checkpointName && checkpoint !== checkpointName) {
      continue
    }

    const command = [
      VIRSH,
      'checkpoint-delete',
      domain,
      checkpoint,
      '--metadata',
    ];

    logger.info(`Removing checkpoint ${checkpoint} from ${domain}`);

    const { stderr } = await asyncExec(command.join(' '));

    if (stderr) {
      throw new Error(stderr);
    }
  }
};

/**
 * Fetches all disks for a given domain.
 *
 * @param {string} domain the domain to find disks for
 * @returns {Promise<Map<string, string>>} A map of disk names to their paths
 */
const fetchAllDisks = async (domain) => {
  const diskList = new Map();

  const command = [VIRSH, 'domblklist', domain, '--details'];

  const { stdout, stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  for (const line of stdout.split(EOL).slice(1)) {
    const words = line.split(' ').filter((d) => d.length > 0);

    // Need at least 4 words to get the disk name
    if (words.length >= 4 && words[1] === 'disk') {
      diskList.set(words[2], words[3].trim());
    }
  }

  return diskList;
};

export {
  domainExists,
  fetchAllDomains,
  findCheckpoints,
  cleanupCheckpoints,
  fetchAllDisks,
};
