import { asyncExec, logger } from '../index.js';
import { findBackupDisks } from './virsh.js';

/**
 * The qemu-img command interface.
 *
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

export const QEMU_IMG = 'qemu-img';

/**
 * Scrubs a domain of any bitmaps that may be left behind from the previous
 * month's backups.
 *
 * @param {string} domain the domain to cleanup bitmaps for
 * @param {Array<string>} approvedDisks a list of approved disks to cleanup
 * bitmaps for besides any virtual disks found.
 */
const cleanupBitmaps = async (domain, approvedDisks = []) => {
  for (const disk of await findBackupDisks(domain, approvedDisks)) {
    const command = [QEMU_IMG, 'info', '-f', 'qcow2', disk, '--output=json'];

    const { stdout, stderr } = await asyncExec(command.join(' '));

    if (stderr) {
      throw new Error(stderr);
    }

    const domainConfig = JSON.parse(stdout);

    const bitmaps = domainConfig['format-specific']['data']['bitmaps'] || [];

    if (bitmaps.length === 0) {
      logger.info(`No bitmaps found for ${disk} on domain ${domain}`);

      continue;
    }

    for (const bitmap of bitmaps) {
      const command = [
        QEMU_IMG,
        'bitmap',
        '--remove',
        '-f',
        'qcow2',
        disk,
        bitmap.name,
      ];

      logger.info(`- Removing bitmap ${bitmap.name} from ${disk} on ${domain}`);

      const { stderr } = await asyncExec(command.join(' '));

      if (stderr) {
        throw new Error(stderr);
      }
    }
  }
};

export { cleanupBitmaps };
