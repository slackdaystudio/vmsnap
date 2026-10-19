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

// The libvirt connection URI (e.g., qemu:///system or qemu:///session)
let libvirtUri = null;

/**
 * Sets the libvirt connection URI for all virsh commands.
 *
 * @param {string|undefined} uri the libvirt URI to use
 */
export const setLibvirtUri = (uri) => {
  libvirtUri = uri;
};

/**
 * Gets the base virsh command with connection URI if set.
 *
 * @returns {string[]} the base virsh command array
 */
const getVirshCommand = () => {
  if (libvirtUri) {
    return [VIRSH, '-c', libvirtUri];
  }
  return [VIRSH];
};

/**
 * Check if a domain is currently running.
 *
 * @param {string} domain the name of the domain
 * @returns {Promise<boolean>} True if domain is running, false if shut off or doesn't exist
 */
const isDomainRunning = async (domain) => {
  const command = [...getVirshCommand(), 'domstate', domain];

  try {
    const { stdout } = await asyncExec(command.join(' '));
    const state = stdout.trim().toLowerCase();
    return state === 'running';
  } catch {
    return false;
  }
};

// Domain states without a QEMU process behind them
const INACTIVE_STATES = ['shut off', 'crashed'];

/**
 * Check if a domain has a live QEMU process, i.e. it is running, paused or in
 * any other state where QEMU holds its disks open.
 *
 * @param {string} domain the name of the domain
 * @returns {Promise<boolean>} True if domain is active, false if shut off or doesn't exist
 */
const isDomainActive = async (domain) => {
  const command = [...getVirshCommand(), 'domstate', domain];

  try {
    const { stdout } = await asyncExec(command.join(' '));
    return !INACTIVE_STATES.includes(stdout.trim().toLowerCase());
  } catch {
    return false;
  }
};

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

  const command = [...getVirshCommand(), 'domstate', domain];

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
  const command = [...getVirshCommand(), 'list', '--all', '--name'];

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
  const command = [...getVirshCommand(), 'checkpoint-list', domain, '--name'];

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

    logger.info(`Removing checkpoint ${checkpoint} from ${domain}`);

    // Delete the checkpoint along with its bitmaps.  Removing only the
    // metadata leaves the bitmaps behind on the disk, and the next full backup
    // then fails because its checkpoint name is already taken by a bitmap.
    try {
      await deleteCheckpoint(domain, checkpoint);
    } catch (error) {
      // libvirt can't delete checkpoints of inactive domains, and fails when
      // the bitmap is already gone.  Either way only the metadata can go; a
      // bitmap scrub removes anything left on the disks.
      logger.warn(
        `Unable to remove checkpoint ${checkpoint} with its bitmaps from ${domain}, removing metadata only (leftover bitmaps are removed by a bitmap scrub): ${error.message}`,
      );

      await deleteCheckpoint(domain, checkpoint, true);
    }
  }
};

/**
 * Deletes a checkpoint from a domain.
 *
 * @param {string} domain the domain to delete the checkpoint from
 * @param {string} checkpoint the name of the checkpoint
 * @param {boolean} metadataOnly true to only remove libvirt's metadata and
 * leave the bitmaps on the disk
 */
const deleteCheckpoint = async (domain, checkpoint, metadataOnly = false) => {
  const command = [...getVirshCommand(), 'checkpoint-delete', domain, checkpoint];

  if (metadataOnly) {
    command.push('--metadata');
  }

  const { stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }
};

/**
 * Sends a QMP command to the QEMU process of a running domain.
 *
 * @param {string} domain the running domain
 * @param {Object} qmpCommand the QMP command to execute
 * @returns {Promise<Object>} the parsed QMP response
 */
const qemuMonitorCommand = async (domain, qmpCommand) => {
  const command = [
    ...getVirshCommand(),
    'qemu-monitor-command',
    domain,
    `'${JSON.stringify(qmpCommand)}'`,
  ];

  const { stdout, stderr } = await asyncExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return JSON.parse(stdout);
};

/**
 * Finds the QEMU block node and live bitmaps of each disk image attached to a
 * running domain.  QEMU keeps a running domain's bitmaps in memory and only
 * writes them to the image on shutdown, so qemu-img cannot see them.
 *
 * @param {string} domain the running domain
 * @returns {Promise<Map<string, {node: string, bitmaps: Array<Object>}>>} the
 * block node and bitmaps of each disk, keyed by image path
 */
const fetchBlockNodes = async (domain) => {
  const response = await qemuMonitorCommand(domain, { execute: 'query-block' });

  const nodes = new Map();

  for (const device of response.return || []) {
    const inserted = device.inserted;

    if (inserted?.file && inserted['node-name']) {
      nodes.set(inserted.file, {
        node: inserted['node-name'],
        bitmaps: inserted['dirty-bitmaps'] || [],
      });
    }
  }

  return nodes;
};

/**
 * Removes a bitmap from a disk of a running domain.  qemu-img cannot modify
 * an image while QEMU has it open, so this goes through QEMU instead.
 *
 * @param {string} domain the running domain
 * @param {string} node the block node holding the bitmap
 * @param {string} bitmap the name of the bitmap
 */
const removeBitmapFromRunningDomain = async (domain, node, bitmap) => {
  await qemuMonitorCommand(domain, {
    execute: 'block-dirty-bitmap-remove',
    arguments: { node, name: bitmap },
  });
};

/**
 * Fetches all disks for a given domain.
 *
 * @param {string} domain the domain to find disks for
 * @returns {Promise<Map<string, string>>} A map of disk names to their paths
 */
const fetchAllDisks = async (domain) => {
  const diskList = new Map();

  const command = [...getVirshCommand(), 'domblklist', domain, '--details'];

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
  isDomainRunning,
  isDomainActive,
  fetchAllDomains,
  findCheckpoints,
  cleanupCheckpoints,
  fetchAllDisks,
  fetchBlockNodes,
  removeBitmapFromRunningDomain,
};
