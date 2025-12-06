import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import VMManager, {
  execVMSnap,
  checkLibvirtAvailable,
} from '../helpers/vm-manager.js';
import {
  backupExists,
  getCheckpoints,
  getBackupSize,
  listMatchingFiles,
} from '../helpers/test-assertions.js';
import {
  ensureCleanBackupDir,
  fullCleanup,
  cleanupLockFiles,
} from '../helpers/cleanup-helpers.js';
import path from 'path';

const TEST_CONFIG = {
  testDir: '/tmp/vmsnap-integration-test',
  backupDir: '/tmp/vmsnap-integration-test/backups',
  vmPrefix: 'vmsnap-test',
};

let libvirtAvailable = false;

describe('Incremental Backup Operations', () => {
  let vmManager;

  beforeAll(async () => {
    const libvirtCheck = await checkLibvirtAvailable();
    libvirtAvailable = libvirtCheck.available;

    if (!libvirtAvailable) {
      console.log('\n⚠️  Skipping integration tests: libvirt not available');
      console.log(`   Reason: ${libvirtCheck.error}\n`);
      return;
    }

    await fullCleanup({
      testDir: TEST_CONFIG.testDir,
      vmPrefix: TEST_CONFIG.vmPrefix,
    });

    vmManager = new VMManager({
      testDir: TEST_CONFIG.testDir,
      vmPrefix: TEST_CONFIG.vmPrefix,
    });

    await vmManager.setup();
    await ensureCleanBackupDir(TEST_CONFIG.backupDir);
  }, 60000);

  afterAll(async () => {
    if (vmManager) {
      await vmManager.cleanup();
    }
    if (libvirtAvailable) {
      await fullCleanup({
        testDir: TEST_CONFIG.testDir,
        vmPrefix: TEST_CONFIG.vmPrefix,
      });
    }
  }, 60000);

  beforeEach((context) => {
    if (!libvirtAvailable) {
      context.skip();
    }
  });

  describe('Second Backup Creates Incremental', () => {
    let testVM;
    let firstBackupSize;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('incremental', { diskSize: '150M' });
    }, 30000);

    afterAll(async () => {
      if (testVM && vmManager) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'first backup is a full backup',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--backup',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);
        expect(await backupExists(TEST_CONFIG.backupDir, testVM.name)).toBe(
          true
        );

        // Record first backup size
        firstBackupSize = await getBackupSize(TEST_CONFIG.backupDir, testVM.name);
        expect(firstBackupSize).toBeGreaterThan(0);

        // Check for backup files (offline VMs use .copy.data, running VMs use .full.data)
        // Files are in backupDir/vmName/vmsnap-backup-monthly-YYYY-MM/
        const vmBackupDir = path.join(TEST_CONFIG.backupDir, testVM.name);
        const subdirs = await listMatchingFiles(vmBackupDir, /vmsnap-backup/);
        expect(subdirs.length).toBeGreaterThan(0);

        // Check inside the first backup subdirectory for data files
        const backupSubdir = path.join(vmBackupDir, subdirs[0]);
        const files = await listMatchingFiles(backupSubdir, /\.(full|copy|data)/);
        expect(files.length).toBeGreaterThan(0);
      },
      120000
    );

    test(
      'first backup creates checkpoint',
      async () => {
        const checkpoints = await getCheckpoints(testVM.name);
        // Offline VMs are now automatically started in paused state for checkpoint creation
        expect(checkpoints.length).toBe(1);
        expect(checkpoints[0]).toMatch(/virtnbdbackup/);
      },
      30000
    );

    test(
      'second backup is incremental',
      async () => {
        // Run second backup
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--backup',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Get new backup size
        const secondBackupSize = await getBackupSize(
          TEST_CONFIG.backupDir,
          testVM.name
        );

        // Total backup size should be larger (includes both backups)
        expect(secondBackupSize).toBeGreaterThan(firstBackupSize);
      },
      120000
    );

    test(
      'second backup creates additional checkpoint',
      async () => {
        const checkpoints = await getCheckpoints(testVM.name);
        // Offline VMs are now automatically started in paused state for checkpoint creation
        expect(checkpoints.length).toBe(2);
      },
      30000
    );
  });

  describe('Multiple Incremental Backups', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('multi-inc', { diskSize: '100M' });
    }, 30000);

    afterAll(async () => {
      if (testVM && vmManager) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'can create multiple incremental backups in sequence',
      async () => {
        // Create 3 backups in sequence
        for (let i = 0; i < 3; i++) {
          const result = await execVMSnap([
            `--domains=${testVM.name}`,
            `--output=${TEST_CONFIG.backupDir}`,
            '--backup',
          ]);

          if (result.exitCode !== 0) {
            console.log(`Backup ${i + 1} failed:`);
            console.log('Stderr:', result.stderr);
          }

          expect(result.exitCode).toBe(0);
        }

        // Verify checkpoints (offline VMs now auto-start in paused state for checkpoint creation)
        const checkpoints = await getCheckpoints(testVM.name);
        expect(checkpoints.length).toBe(3);

        // Verify backup directory exists with content
        expect(await backupExists(TEST_CONFIG.backupDir, testVM.name)).toBe(
          true
        );
      },
      360000
    );
  });

  describe('Backup After Disk Changes', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('disk-changes', {
        diskSize: '200M',
      });
    }, 30000);

    afterAll(async () => {
      if (testVM && vmManager) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'handles disk with no changes efficiently',
      async () => {
        // First backup (full)
        const result1 = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--backup',
        ]);

        if (result1.exitCode !== 0) {
          console.log('First backup failed:', result1.stderr);
        }
        expect(result1.exitCode).toBe(0);

        const firstSize = await getBackupSize(
          TEST_CONFIG.backupDir,
          testVM.name
        );

        // Second backup with no changes
        const result2 = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--backup',
        ]);

        if (result2.exitCode !== 0) {
          console.log('Second backup failed:', result2.stderr);
        }
        expect(result2.exitCode).toBe(0);

        const secondSize = await getBackupSize(
          TEST_CONFIG.backupDir,
          testVM.name
        );

        // Second backup should add minimal overhead for unchanged data
        // The incremental should be much smaller than the full
        const incrementSize = secondSize - firstSize;
        expect(incrementSize).toBeLessThan(firstSize * 0.5);
      },
      240000
    );
  });
});
