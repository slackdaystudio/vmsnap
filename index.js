#!/usr/bin/env node
/**
 * This script is designed to backup KVM virtual machines using the
 * virtnbdbackup utility.  It relies on the virsh and qemu-img utilities as well
 * so please make sure you have them installed.
 *
 * Usage: node index.js --domains=<domain> --output=<output directory>
 *
 * --domains: Comma-separated list of domains to backup.  Use '*' to backup all
 * domains.
 * --output: Output directory for the backups.  Only supply the root of where
 * you want the backups to go.  The script will create a directory for each
 * domain and a subdirectory for each year/month.
 * --prune=<true|false> (Optional), this will delete the previous month's
 * backups if it's the middle of the month and the backups exist.
 *
 * @author: Philip J. Guinchard <phil.guinchard@gmail.com>
 */

import { exit } from 'process';
import { access, rm } from 'fs/promises';
import { exec, spawn } from 'child_process';
import util from 'util';
import dayjs from 'dayjs';
import Yargs from 'yargs';
import commandExists from 'command-exists';

// Need to promisify exec to use async/await
const localExec = util.promisify(exec);

// Our required programs
const VIRSH = 'virsh';

const QEMU_IMG = 'qemu-img';

const BACKUP = 'virtnbdbackup';

// Parse command line arguments
const argv = Yargs(process.argv.slice(2)).argv;

/**
 * Check if all dependencies are installed
 */
const checkDependencies = async () => {
  try {
    await commandExists(VIRSH);
    await commandExists(QEMU_IMG);
    await commandExists(BACKUP);
  } catch (error) {
    throw new Error(
      `Missing dependencies: check for ${VIRSH}, ${QEMU_IMG} and ${BACKUP}`,
    );
  }
};

/**
 * Returns the name of the backup folder for the current month.
 *
 * @returns {string} Current date in the format YYYY-MM
 */
const getBackupFolder = () => {
  return dayjs().format('YYYY-MM');
};

/**
 * Returns last months backup folder name.
 *
 * @returns {string} Previous month in the format YYYY-MM
 */
const getPreviousBackupFolder = () => {
  return dayjs().subtract(1, 'month').format('YYYY-MM');
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
    console.error(`Domain ${domain} contains invalid characters`);

    return false;
  }

  const command = [VIRSH, 'domstate', domain];

  try {
    const { stderr } = await localExec(command.join(' '));

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

  const { stdout, stderr } = await localExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return stdout.split('\n').filter((d) => d.length > 0);
};

/**
 * Inspects the --domains CLI argument and returns a list of domains to backup.
 *
 * @returns {Promise<Array<string>>} List of domains to backup
 */
const parseDomains = async () => {
  let domains = [];

  if (argv.domains.indexOf(',') > -1) {
    domains = argv.domains.split(',');
  } else if (argv.domains === '*') {
    domains = await fetchAllDomains();
  } else if (typeof argv.domains === 'string') {
    domains.push(argv.domains);
  } else {
    throw new Error(`Invalid domain name: ${argv.domains}`);
  }

  return domains;
};

/**
 * Perform a backup of a domain, running or stopped.
 *
 * @param {Promise<string>} domain the domain to backup
 */
const backup = async (domain) => {
  if (await domainExists(domain)) {
    const commandOpts = [
      '-S',
      '--noprogress',
      '-d',
      domain,
      '-l',
      'auto',
      '-o',
      `${argv.output}/${domain}/${getBackupFolder()}`,
    ];

    const child = spawn(BACKUP, commandOpts, {
      uid: 0,
      gid: 0,
      stdio: 'inherit',
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');

      child.stdout.on('data', (data) => {
        console.log(data);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8');

      child.stderr.on('data', (data) => {
        console.error(data);
      });
    }

    child.on('close', (code) => {
      if (code !== 0) {
        throw new Error(`Backup for ${domain} failed with code ${code}`);
      }
    });
  } else {
    console.error(`${domain} does not exist`);
  }
};

/**
 * Lists all virtual disks for a given domain.
 *
 * @param {string} domain the domain to find virtual disks for
 * @returns {Promise<Array<string>} List of virtual disks
 */
const findVirtualDisks = async (domain) => {
  const command = [VIRSH, 'domblklist', domain, '--details'];

  const { stdout, stderr } = await localExec(command.join(' '));

  if (stderr) {
    throw new Error(stderr);
  }

  return stdout
    .split('\n')
    .map((line) => {
      const disks = line.split(' ').filter((d) => d.length > 0);

      // Check if the disk is a virtual disk and not something else like a cdrom
      if (disks.length >= 4 && disks[2].startsWith('vd')) {
        return disks[disks.length - 1];
      }
    })
    .filter((d) => d !== undefined);
};

/**
 * Scrubs a domain of any bitmaps that may be left behind from the previous
 * month's backups.
 *
 * @param {string} domain the domain to cleanup bitmaps for
 */
const cleanupBitmaps = async (domain) => {
  for (const disk of await findVirtualDisks(domain)) {
    const command = [QEMU_IMG, 'info', '-f', 'qcow2', disk, '--output=json'];

    const { stdout, stderr } = await localExec(command.join(' '));

    if (stderr) {
      throw new Error(stderr);
    }

    const domainConfig = JSON.parse(stdout);

    const bitmaps = domainConfig['format-specific']['data']['bitmaps'] || [];

    if (bitmaps.length === 0) {
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

      const { stderr } = await localExec(command.join(' '));

      if (stderr) {
        throw new Error(stderr);
      }
    }
  }
};

/**
 * Returns a list of checkpoints for a given domain.
 *
 * @param {string} domain the domain to find checkpoints for
 * @returns
 */
const findCheckpoints = async (domain) => {
  const command = [VIRSH, 'checkpoint-list', domain, '--name'];

  const { stdout, stderr } = await localExec(command.join(' '));

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

    const { stderr } = await localExec(command.join(' '));

    if (stderr) {
      throw new Error(stderr);
    }
  }
};

const isLastMonthsBackupCreated = async (lastMonthsBackupsDir) => {
  try {
    await access(lastMonthsBackupsDir);

    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Main function
 */
const main = async () => {
  if (!argv.domains) {
    throw new Error('No domains specified');
  }

  if (!argv.output) {
    throw new Error('No output directory specified');
  }

  for (const domain of await parseDomains()) {
    const lastMonthsBackupsDir = `${argv.output}/${domain}/${getPreviousBackupFolder()}`;

    // If it's the first of the month, run a cleanup for any the bitmaps and
    // checkpoints found for the domain.
    if (dayjs().date() === 1) {
      console.log('First of the month, running cleanup');

      await cleanupCheckpoints(domain);

      await cleanupBitmaps(domain);
    }

    await backup(domain);

    // If it's the middle of the month, run a cleanup of the previous month's
    // backups if they exist and the prune flag is set.
    if (
      argv.prune === 'true' &&
      dayjs().date() >= 15 &&
      (await isLastMonthsBackupCreated(lastMonthsBackupsDir))
    ) {
      console.log('Middle of the month, running cleanup');

      // Delete last months backups
      await rm(lastMonthsBackupsDir, { recursive: true, force: true });
    }
  }
};

// Check dependencies and run main function
checkDependencies().catch((err) => {
  console.error(err);

  exit(1);
});

// Run the main function
main().catch((err) => {
  console.error(err);

  exit(2);
});
