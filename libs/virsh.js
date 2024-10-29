import { asyncExec } from '../index.js';
import { logger } from '../index.js';

/**
 * The virsh command functions.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

export const VIRSH = 'virsh';

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
    const { stderr } = await asyncExec(command.join(' '));

    return Object.hasOwn(stderr, 'code') ? stderr.code === 0 : true;
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

  return stdout.split('\n').filter((d) => d.length > 0);
};

/**
 * Returns a list of checkpoints for a given domain.
 *
 * @param {string} domain the domain to find checkpoints for
 * @returns
 */
const findCheckpoints = async (domain) => {
  const command = [VIRSH, 'checkpoint-list', domain, '--name'];

  const { stdout, stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return stdout.split('\n').filter((c) => c.trim() !== '');
};

/**
 * Removes all checkpoints from a given domain.
 *
 * @param {string} domain the domain to cleanup checkpoints for
 */
const cleanupCheckpoints = async (domain) => {
  const checkpoints = await findCheckpoints(domain);

  if (checkpoints.length === 0) {
    return;
  }

  for (const checkpoint of checkpoints) {
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

  for (const line of stdout.split('\n')) {
    const disks = line.split(' ').filter((d) => d.length > 0);

    // Need at least 4 columns to get the disk name
    if (disks.length >= 4) {
      diskList.set(disks[4], disks[disks.length - 1].trim());
    }
  }

  return diskList;
};

/**
 * Lists all virtual disks for a given domain.
 *
 * @param {string} domain the domain to find virtual disks for
 * @param {Array<string>} approvedDisks a list of approved disks to cleanup
 * @returns {Promise<Array<string>} List of virtual disks
 */
const findBackupDisks = async (domain, approvedDisks = []) => {
  const command = [VIRSH, 'domblklist', domain, '--details'];

  const { stdout, stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return stdout
    .split('\n')
    .map((line) => {
      const disks = line.split(' ').filter((d) => d.length > 0);

      // Check if the disk is a virtual disk and not something else like a cdrom
      if (
        disks.length >= 4 &&
        (disks[2].startsWith('vd') || approvedDisks.includes(disks[2]))
      ) {
        return disks[disks.length - 1];
      }
    })
    .filter((d) => d !== undefined);
};

export {
  domainExists,
  fetchAllDomains,
  cleanupCheckpoints,
  fetchAllDisks,
  findBackupDisks,
};
