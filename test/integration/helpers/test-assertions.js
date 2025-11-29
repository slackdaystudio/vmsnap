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

/**
 * Check if a backup exists for a given VM
 * @param {string} backupDir - The base backup directory
 * @param {string} vmName - The VM name to check
 * @returns {Promise<boolean>} - Whether the backup exists
 */
export async function backupExists(backupDir, vmName) {
  const vmBackupDir = path.join(backupDir, vmName);
  try {
    const stats = await fs.stat(vmBackupDir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a specific number of checkpoints exist for a VM
 * @param {TestVM} vm - The test VM instance
 * @param {number} expectedCount - Expected number of checkpoints
 * @returns {Promise<boolean>} - Whether the expected count matches
 */
export async function checkpointsExist(vm, expectedCount) {
  const checkpoints = await vm.getCheckpoints();
  return checkpoints.length === expectedCount;
}

/**
 * Get checkpoints for a VM by name
 * @param {string} vmName - The VM name
 * @returns {Promise<string[]>} - List of checkpoint names
 */
export async function getCheckpoints(vmName) {
  try {
    const { stdout } = await execAsync(
      getVirshCmd(`checkpoint-list ${vmName} --name`)
    );
    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim());
  } catch {
    return [];
  }
}

/**
 * Get bitmaps for a VM's disk
 * @param {string} diskPath - Path to the disk image
 * @returns {Promise<string[]>} - List of bitmap names
 */
export async function getBitmaps(diskPath) {
  try {
    const { stdout } = await execAsync(
      `qemu-img info --output=json ${diskPath}`
    );
    const info = JSON.parse(stdout);
    if (info['format-specific']?.data?.bitmaps) {
      return info['format-specific'].data.bitmaps.map((b) => b.name);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Get the size of a backup directory
 * @param {string} backupDir - The base backup directory
 * @param {string} vmName - The VM name
 * @returns {Promise<number>} - Size in bytes
 */
export async function getBackupSize(backupDir, vmName) {
  const vmBackupDir = path.join(backupDir, vmName);
  try {
    const { stdout } = await execAsync(`du -sb ${vmBackupDir}`);
    return parseInt(stdout.split('\t')[0], 10);
  } catch {
    return 0;
  }
}

/**
 * Check if a directory exists
 * @param {string} dirPath - Path to check
 * @returns {Promise<boolean>} - Whether the directory exists
 */
export async function directoryExists(dirPath) {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a file exists
 * @param {string} filePath - Path to check
 * @returns {Promise<boolean>} - Whether the file exists
 */
export async function fileExists(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * List files in a directory matching a pattern
 * @param {string} dirPath - Directory to search
 * @param {RegExp} pattern - Pattern to match filenames
 * @returns {Promise<string[]>} - List of matching filenames
 */
export async function listMatchingFiles(dirPath, pattern) {
  try {
    const files = await fs.readdir(dirPath);
    return files.filter((f) => pattern.test(f));
  } catch {
    return [];
  }
}

/**
 * Count backup directories in a path
 * @param {string} backupPath - The backup path to check
 * @returns {Promise<number>} - Number of backup directories
 */
export async function countBackupDirs(backupPath) {
  try {
    const entries = await fs.readdir(backupPath, { withFileTypes: true });
    return entries.filter(
      (e) => e.isDirectory() && e.name.startsWith('vmsnap-backup')
    ).length;
  } catch {
    return 0;
  }
}

/**
 * Get backup directory names matching a groupBy pattern
 * @param {string} backupPath - The backup path to check
 * @param {string} groupBy - The groupBy type (month, quarter, bi-annual, year)
 * @returns {Promise<string[]>} - List of matching directory names
 */
export async function getBackupDirsByGroup(backupPath, groupBy) {
  const prefixes = {
    month: 'vmsnap-backup-monthly',
    quarter: 'vmsnap-backup-quarterly',
    'bi-annual': 'vmsnap-backup-bi-annually',
    year: 'vmsnap-backup-yearly',
  };

  const prefix = prefixes[groupBy] || 'vmsnap-backup';

  try {
    const entries = await fs.readdir(backupPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Verify backup integrity by checking expected files exist
 * @param {string} backupDir - The backup directory
 * @param {string} vmName - The VM name
 * @returns {Promise<{valid: boolean, errors: string[]}>} - Validation result
 */
export async function verifyBackupIntegrity(backupDir, vmName) {
  const vmBackupDir = path.join(backupDir, vmName);
  const errors = [];

  try {
    // Check if backup directory exists
    if (!(await directoryExists(vmBackupDir))) {
      return { valid: false, errors: ['Backup directory does not exist'] };
    }

    // Check for expected files (virtnbdbackup creates these)
    const files = await fs.readdir(vmBackupDir);

    // Should have at least a data file and checksum file
    const hasDataFile = files.some(
      (f) => f.endsWith('.data') || f.endsWith('.full') || f.endsWith('.inc')
    );
    if (!hasDataFile) {
      errors.push('No data files found in backup');
    }

    // Check for vmconfig file (domain XML backup)
    const hasConfig = files.some((f) => f.includes('vmconfig'));
    if (!hasConfig) {
      errors.push('No vmconfig file found');
    }

    return { valid: errors.length === 0, errors };
  } catch (error) {
    return { valid: false, errors: [error.message] };
  }
}

/**
 * Parse vmsnap JSON output
 * @param {string} jsonString - JSON string to parse (may contain non-JSON text like spinner output)
 * @returns {object|null} - Parsed object or null on failure
 */
export function parseVMSnapJSON(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch {
    // Try to extract JSON from mixed output (spinner text + JSON)
    // Look for JSON object pattern
    const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Wait for a condition to be true
 * @param {Function} condition - Async function returning boolean
 * @param {number} timeoutMs - Maximum time to wait
 * @param {number} intervalMs - Check interval
 * @returns {Promise<boolean>} - Whether condition was met
 */
export async function waitForCondition(
  condition,
  timeoutMs = 30000,
  intervalMs = 500
) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export default {
  backupExists,
  checkpointsExist,
  getCheckpoints,
  getBitmaps,
  getBackupSize,
  directoryExists,
  fileExists,
  listMatchingFiles,
  countBackupDirs,
  getBackupDirsByGroup,
  verifyBackupIntegrity,
  parseVMSnapJSON,
  waitForCondition,
};
