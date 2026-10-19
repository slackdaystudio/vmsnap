import { sep } from 'path';
import { asyncExec, logger } from '../vmsnap.js';
import { findKeyByValue } from './general.js';
import {
  CHECKPOINT_REGEX,
  fetchAllDisks,
  fetchBlockNodes,
  isDomainActive,
  removeBitmapFromRunningDomain,
} from './virsh.js';

/**
 * The qemu-img command interface.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

export const QEMU_IMG = 'qemu-img';

/**
 * Finds all bitmaps for a given domain and returns a JSON object with the disk
 * properties and the bitmaps found.
 *
 * @param {string} domain the name of the domain to find bitmaps for
 * @returns {Promise<Array<Object>>} a list of bitmaps found for the domain
 */
const findBitmaps = async (domain) => {
  const bitmaps = [];

  const disks = await fetchAllDisks(domain);

  // QEMU keeps a running domain's bitmaps in memory, so ask it directly
  // instead of trusting what is on the image.
  let liveNodes;

  if (await isDomainActive(domain)) {
    try {
      liveNodes = await fetchBlockNodes(domain);
    } catch (error) {
      logger.warn(
        `Unable to query live bitmaps for ${domain}, using the disk images: ${error.message}`,
      );
    }
  }

  for (const disk of disks.values()) {
    // -U (force share) lets us read images that a running VM has locked
    const command = [QEMU_IMG, 'info', '-U', disk, '--output=json'];

    try {
      const { stdout } = await asyncExec(command.join(' '));

      const domainConfig = JSON.parse(stdout);

      const type = domainConfig['format'];

      const live = liveNodes?.get(disk);

      bitmaps.push({
        disk: findKeyByValue(disks, disk),
        virtualSize: domainConfig['virtual-size'],
        actualSize: domainConfig['actual-size'],
        type,
        name: disk.split(sep).pop(),
        path: disk,
        // The QEMU block node, only set when the domain is running
        node: live?.node,
        bitmaps:
          type === 'raw'
            ? []
            : live?.bitmaps ||
              domainConfig['format-specific']['data']['bitmaps'] ||
              [],
      });
    } catch (error) {
      continue;
    }
  }

  return bitmaps;
};

/**
 * Scrubs a domain of any bitmaps that may be left behind from the previous
 * month's backups.
 *
 * @param {string} domain the domain to cleanup bitmaps for bitmaps for besides 
 * any virtual disks found.
 */
const cleanupBitmaps = async (domain, checkpointName = undefined) => {
  const bitmaps = await findBitmaps(domain);

  // A running or paused VM holds its disks open, so its bitmaps must be
  // removed through QEMU rather than qemu-img.
  const running = await isDomainActive(domain);

  for (const record of bitmaps) {
    if (record.bitmaps.length === 0) {
      logger.info(`No bitmaps found for ${record.disk} on domain ${domain}`);

      continue;
    }

    for (const bitmap of record.bitmaps) {
      // Adding just in case we have a bitmap that isn't ours.  Not sure if 
      // this is possible, but better safe than sorry.
      if (CHECKPOINT_REGEX.test(bitmap.name) === false) {
        continue;
      }

      // If we have a checkpoint name and it doesn't match, skip it
      if (checkpointName && bitmap.name !== checkpointName) {
        continue;
      }

      logger.info(
        `Removing bitmap ${bitmap.name} from ${record.path} on ${domain}`,
      );

      try {
        if (running) {
          if (!record.node) {
            throw new Error(`no block node found for ${record.path}`);
          }

          await removeBitmapFromRunningDomain(domain, record.node, bitmap.name);
        } else {
          const command = [
            QEMU_IMG,
            'bitmap',
            '--remove',
            record.path,
            bitmap.name,
          ];

          await asyncExec(command.join(' '));
        }
      } catch (error) {
        logger.warn(
          `Error removing bitmap ${bitmap.name} from ${record.path} on ${domain}: ${error.message}`,
        );

        continue;
      }
    }
  }
};

export { findBitmaps, cleanupBitmaps };
