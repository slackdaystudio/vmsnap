import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// Connection URI for libvirt - use system connection when running as root
const LIBVIRT_URI = process.getuid?.() === 0 ? 'qemu:///system' : null;

/**
 * Get virsh command with optional connection URI
 */
function getVirshCmd(subcommand) {
  if (LIBVIRT_URI) {
    return `virsh -c ${LIBVIRT_URI} ${subcommand}`;
  }
  return `virsh ${subcommand}`;
}

// Default test directories
const TEST_DIRS = {
  testDir: '/tmp/vmsnap-integration-test',
  backupDir: '/tmp/vmsnap-integration-test/backups',
};

/**
 * Clean up a specific backup directory
 * @param {string} backupDir - The backup directory to clean
 */
export async function cleanupBackupDir(backupDir) {
  try {
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Ensure a clean backup directory exists
 * @param {string} backupDir - The backup directory path
 */
export async function ensureCleanBackupDir(backupDir) {
  await cleanupBackupDir(backupDir);
  await fs.mkdir(backupDir, { recursive: true });
}

/**
 * Clean up all test VMs matching a prefix
 * @param {string} prefix - VM name prefix to match
 */
export async function cleanupTestVMs(prefix = 'vmsnap-test') {
  try {
    const { stdout } = await execAsync(getVirshCmd('list --all --name'));
    const allVMs = stdout.trim().split('\n').filter(Boolean);
    const testVMs = allVMs.filter((name) => name.startsWith(prefix));

    for (const vmName of testVMs) {
      // Destroy if running
      await execAsync(getVirshCmd(`destroy ${vmName}`) + ' 2>/dev/null || true');

      // Delete checkpoints
      try {
        const { stdout: checkpoints } = await execAsync(
          getVirshCmd(`checkpoint-list ${vmName} --name`) + ' 2>/dev/null || true'
        );
        const checkpointList = checkpoints.trim().split('\n').filter(Boolean);
        for (const checkpoint of checkpointList) {
          await execAsync(
            getVirshCmd(`checkpoint-delete ${vmName} ${checkpoint}`) + ' 2>/dev/null || true'
          );
        }
      } catch {
        // Ignore
      }

      // Undefine
      await execAsync(
        getVirshCmd(`undefine ${vmName} --checkpoints-metadata`) + ' 2>/dev/null || true'
      );
      await execAsync(getVirshCmd(`undefine ${vmName}`) + ' 2>/dev/null || true');
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clean up test disk images and XML files
 * @param {string} testDir - The test directory containing files
 */
export async function cleanupTestFiles(testDir = TEST_DIRS.testDir) {
  try {
    const files = await fs.readdir(testDir);
    for (const file of files) {
      if (file.endsWith('.qcow2') || file.endsWith('.xml')) {
        await fs.rm(path.join(testDir, file), { force: true });
      }
    }
  } catch {
    // Directory might not exist
  }
}

/**
 * Full cleanup of the test environment
 * @param {object} options - Cleanup options
 */
export async function fullCleanup(options = {}) {
  const testDir = options.testDir || TEST_DIRS.testDir;
  const vmPrefix = options.vmPrefix || 'vmsnap-test';

  // Clean up VMs first
  await cleanupTestVMs(vmPrefix);

  // Clean up files
  await cleanupTestFiles(testDir);

  // Optionally remove the entire test directory
  if (options.removeTestDir) {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Create a mock backup directory structure for testing pruning
 * @param {string} backupDir - Base backup directory
 * @param {string} vmName - VM name
 * @param {Date} date - Date for the backup
 * @param {string} groupBy - Grouping type
 */
export async function createMockBackup(backupDir, vmName, date, groupBy) {
  const dayjs = (await import('dayjs')).default;
  const dateObj = dayjs(date);

  // Determine directory name based on groupBy
  let dirName;
  switch (groupBy) {
    case 'month':
      dirName = `vmsnap-backup-monthly-${dateObj.format('YYYY-MM')}`;
      break;
    case 'quarter':
      dirName = `vmsnap-backup-quarterly-${dateObj.format('YYYY')}-Q${Math.ceil((dateObj.month() + 1) / 3)}`;
      break;
    case 'bi-annual':
      dirName = `vmsnap-backup-bi-annually-${dateObj.format('YYYY')}-H${dateObj.month() < 6 ? 1 : 2}`;
      break;
    case 'year':
      dirName = `vmsnap-backup-yearly-${dateObj.format('YYYY')}`;
      break;
    default:
      dirName = `vmsnap-backup-${dateObj.format('YYYY-MM-DD')}`;
  }

  const backupPath = path.join(backupDir, dirName, vmName);
  await fs.mkdir(backupPath, { recursive: true });

  // Create minimal mock backup files
  await fs.writeFile(path.join(backupPath, 'vmconfig.xml'), '<domain></domain>');
  await fs.writeFile(path.join(backupPath, 'vda.full.data'), 'mock-data');
  await fs.writeFile(
    path.join(backupPath, 'backup.json'),
    JSON.stringify({ date: date.toISOString(), type: 'full' })
  );

  return path.join(backupDir, dirName);
}

/**
 * Remove lock files that might interfere with tests
 * @param {string} lockDir - Directory containing lock files
 */
export async function cleanupLockFiles(lockDir = '/tmp') {
  try {
    const files = await fs.readdir(lockDir);
    for (const file of files) {
      if (file.startsWith('vmsnap') && file.endsWith('.lock')) {
        await fs.rm(path.join(lockDir, file), { force: true });
      }
    }
  } catch {
    // Ignore
  }
}

/**
 * Verify environment is clean before tests
 * @param {string} vmPrefix - VM prefix to check
 * @returns {Promise<{clean: boolean, issues: string[]}>}
 */
export async function verifyCleanEnvironment(vmPrefix = 'vmsnap-test') {
  const issues = [];

  // Check for lingering VMs
  try {
    const { stdout } = await execAsync(getVirshCmd('list --all --name'));
    const testVMs = stdout
      .trim()
      .split('\n')
      .filter((name) => name.startsWith(vmPrefix));
    if (testVMs.length > 0) {
      issues.push(`Found lingering VMs: ${testVMs.join(', ')}`);
    }
  } catch {
    issues.push('Could not check for VMs');
  }

  // Check for lock files
  try {
    const files = await fs.readdir('/tmp');
    const lockFiles = files.filter(
      (f) => f.startsWith('vmsnap') && f.endsWith('.lock')
    );
    if (lockFiles.length > 0) {
      issues.push(`Found lock files: ${lockFiles.join(', ')}`);
    }
  } catch {
    // Ignore
  }

  return { clean: issues.length === 0, issues };
}

export default {
  cleanupBackupDir,
  ensureCleanBackupDir,
  cleanupTestVMs,
  cleanupTestFiles,
  fullCleanup,
  createMockBackup,
  cleanupLockFiles,
  verifyCleanEnvironment,
};
