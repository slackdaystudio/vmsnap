#!/usr/bin/env node
/**
 * This script is designed to backup KVM virtual machines using the
 * virtnbdbackup utility.  It relies on the virsh and qemu-img utilities as well
 * so please make sure you have them installed.
 *
 * Usage: node index.js --domains=<domain> --output=<output>
 *
 * --domains: Comma-separated list of domains to backup.  Use '*' to backup all
 * domains.
 * --output: Output directory for the backups.  Only supply the root of where
 * you want the backups to go.  The script will create a directory for each
 * domain and a subdirectory for each year/month.
 *
 * @author: Philip J. Guinchard <phil.guinchard@gmail.com>
 */

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
      'Missing dependencies: check if virsh, qemu-img and virtnbdbackup are installed',
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
      `${domain}`,
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

    child.stdout.setEncoding('utf8');

    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (data) => {
      console.log(data);
    });

    child.stderr.on('data', (data) => {
      console.error(data);
    });

    child.on('close', (code) => {
      console.log(`closing code: ${code}`);
    });
  } else {
    console.error(`${domain} does not exist`);
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
    await backup(domain);
  }

  process.exit(0);
};

// Check dependencies and run main function
checkDependencies()
  .then(() => main())
  .catch((err) => {
    console.error(err);

    process.exit(1);
  });
