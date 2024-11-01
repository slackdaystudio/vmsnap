import { spawn } from 'child_process';
import dayjs from 'dayjs';
import { logger } from '../vmsnap.js';
import { domainExists } from './virsh.js';

/**
 * Our functions for interfacing with the virtnbdbackup utility.
 * 
 * @author: Philip J. Guinchard <phil.guinchard@slackdaystudio.ca>
 */

export const BACKUP = 'virtnbdbackup';

/**
 * Perform a backup of a domain, running or stopped.
 *
 * @param {Promise<string>} domain the domain to backup
 */
const backup = async (domain, outputDir, raw = false) => {
  if (!(await domainExists(domain))) {
    logger.warn(`${domain} does not exist`);

    return;
  }

  const commandOpts = [
    '-S',
    '--noprogress',
    '-d',
    domain,
    '-l',
    'auto',
    '-o',
    `${outputDir}/${domain}/${dayjs().format('YYYY-MM')}`,
  ];

  if (raw) {
    commandOpts.push('--raw');
  }

  const child = spawn(BACKUP, commandOpts, {
    cwd: import.meta.dirname,
    uid: 0,
    gid: 0,
    stdio: 'inherit',
  });

  if (child.stdout) {
    child.stdout.setEncoding('utf8');

    child.stdout.on('data', (data) => {
      logger.info(data);
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (data) => {
      logger.error(data);
    });
  }

  // Wait for the backup to finish
  await new Promise((resolve) => {
    child.on('close', (code) => {
      if (code !== 0) {
        logger.error(`Backup for ${domain} failed with code ${code}`);
      }

      resolve();
    });
  });
};

export { backup };
