import prettyBytes from 'pretty-bytes';
import { asyncExec, logger } from '../vmsnap.js';
import { findKeyByValue } from './general.js';
import { fetchAllDisks } from './virsh.js';

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

  for (const disk of disks.values()) {
    const command = [QEMU_IMG, 'info', disk, '--output=json'];

    try {
      const { stdout } = await asyncExec(command.join(' '));

      const domainConfig = JSON.parse(stdout);

      const type = domainConfig['format'];

      bitmaps.push({
        disk: findKeyByValue(disks, disk),
        virtualSize: prettyBytes(domainConfig['virtual-size']),
        actualSize: prettyBytes(domainConfig['actual-size']),
        type,
        name: disk.split('/').pop(),
        path: disk,
        bitmaps:
          type === 'raw'
            ? []
            : domainConfig['format-specific']['data']['bitmaps'] || [],
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
 * @param {string} domain the domain to cleanup bitmaps for
 * @param {Array<string>} approvedDisks a list of approved disks to cleanup
 * bitmaps for besides any virtual disks found.
 */
const cleanupBitmaps = async (domain, approvedDisks = []) => {
  const bitmaps = await findBitmaps(domain, approvedDisks);

  for (const record of bitmaps) {
    if (record.bitmaps.length === 0) {
      logger.info(`No bitmaps found for ${record.disk} on domain ${domain}`);

      continue;
    }

    for (const bitmap of record.bitmaps) {
      const command = [
        QEMU_IMG,
        'bitmap',
        '--remove',
        record.path,
        bitmap.name,
      ];

      logger.info(
        `- Removing bitmap ${bitmap.name} from ${record.path} on ${domain}`,
      );

      try {
        logger.info(
          `- Removing bitmap ${bitmap.name} from ${record.path} on ${domain}`,
        );

        await asyncExec(command.join(' '));
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
