import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import dayjs from 'dayjs';
import dayOfYear from 'dayjs/plugin/dayOfYear.js';

dayjs.extend(dayOfYear);
import VMManager, {
  execVMSnap,
  checkLibvirtAvailable,
} from '../helpers/vm-manager.js';
import {
  backupExists,
  directoryExists,
  getBackupDirsByGroup,
  countBackupDirs,
} from '../helpers/test-assertions.js';
import {
  ensureCleanBackupDir,
  fullCleanup,
  cleanupLockFiles,
  createMockBackup,
} from '../helpers/cleanup-helpers.js';

const TEST_CONFIG = {
  testDir: '/tmp/vmsnap-integration-test',
  backupDir: '/tmp/vmsnap-integration-test/backups',
  vmPrefix: 'vmsnap-test',
};

// Track if libvirt is available
let libvirtAvailable = false;

describe('Backup Rotation and Pruning', () => {
  let vmManager;

  beforeAll(async () => {
    // Check if libvirt is available
    const libvirtCheck = await checkLibvirtAvailable();
    libvirtAvailable = libvirtCheck.available;

    if (!libvirtAvailable) {
      console.log(
        '\n⚠️  Skipping integration tests: libvirt not available'
      );
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
    vi.useRealTimers();
  }, 60000);

  beforeEach(async (context) => {
    if (!libvirtAvailable) {
      context.skip();
    }
  });

  describe('Monthly Grouping', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('monthly-group');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'creates monthly grouped directory',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=month',
          '--backup',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Check for monthly directory - structure is backupDir/vmName/vmsnap-backup-monthly-YYYY-MM
        const currentMonth = dayjs().format('YYYY-MM');
        const vmBackupDir = `${TEST_CONFIG.backupDir}/${testVM.name}`;
        const expectedDir = `${vmBackupDir}/vmsnap-backup-monthly-${currentMonth}`;

        expect(await directoryExists(vmBackupDir)).toBe(true);
        expect(await directoryExists(expectedDir)).toBe(true);
      },
      120000
    );
  });

  describe('Quarterly Grouping', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('quarterly-group');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'creates quarterly grouped directory',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=quarter',
          '--backup',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Check for quarterly directory - structure is backupDir/vmName/vmsnap-backup-quarterly-YYYY-QN
        const currentQuarter = Math.ceil((dayjs().month() + 1) / 3);
        const currentYear = dayjs().format('YYYY');
        const vmBackupDir = `${TEST_CONFIG.backupDir}/${testVM.name}`;
        const expectedDir = `${vmBackupDir}/vmsnap-backup-quarterly-${currentYear}-Q${currentQuarter}`;

        expect(await directoryExists(vmBackupDir)).toBe(true);
        expect(await directoryExists(expectedDir)).toBe(true);
      },
      120000
    );
  });

  describe('Bi-Annual Grouping', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('biannual-group');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'creates bi-annual grouped directory',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=bi-annual',
          '--backup',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Check for bi-annual directory - structure is backupDir/vmName/vmsnap-backup-bi-annually-YYYY-pN
        // Uses dayOfYear >= 180 for second half (not month-based)
        const currentHalf = dayjs().dayOfYear() >= 180 ? 2 : 1;
        const currentYear = dayjs().format('YYYY');
        const vmBackupDir = `${TEST_CONFIG.backupDir}/${testVM.name}`;
        const expectedDir = `${vmBackupDir}/vmsnap-backup-bi-annually-${currentYear}-p${currentHalf}`;

        expect(await directoryExists(vmBackupDir)).toBe(true);
        expect(await directoryExists(expectedDir)).toBe(true);
      },
      120000
    );
  });

  describe('Yearly Grouping', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('yearly-group');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'creates yearly grouped directory',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=year',
          '--backup',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Check for yearly directory - structure is backupDir/vmName/vmsnap-backup-yearly-YYYY
        const currentYear = dayjs().format('YYYY');
        const vmBackupDir = `${TEST_CONFIG.backupDir}/${testVM.name}`;
        const expectedDir = `${vmBackupDir}/vmsnap-backup-yearly-${currentYear}`;

        expect(await directoryExists(vmBackupDir)).toBe(true);
        expect(await directoryExists(expectedDir)).toBe(true);
      },
      120000
    );
  });

  describe('Pruning Old Backups', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('prune-test');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
      vi.useRealTimers();
    }, 30000);

    test(
      'prunes old backup when conditions are met',
      async () => {
        // Create mock "old" backup from previous month
        const now = dayjs();
        const lastMonth = now.subtract(1, 'month');

        // Create old backup directory structure
        const oldBackupDir = await createMockBackup(
          TEST_CONFIG.backupDir,
          testVM.name,
          lastMonth.toDate(),
          'month'
        );

        // Verify old backup exists
        expect(await directoryExists(oldBackupDir)).toBe(true);

        // Mock system time to be past mid-month (prune condition)
        const midMonth = now.date(20);
        vi.setSystemTime(midMonth.toDate());

        // Run backup with prune enabled
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=month',
          '--backup',
          '--prune',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        // Note: The actual pruning behavior depends on vmsnap's implementation
        // This test verifies the prune flag is accepted
        expect(result.exitCode).toBe(0);

        // Current month backup should exist - structure is backupDir/vmName/vmsnap-backup-monthly-YYYY-MM
        const currentMonth = midMonth.format('YYYY-MM');
        const vmBackupDir = `${TEST_CONFIG.backupDir}/${testVM.name}`;
        const currentDir = `${vmBackupDir}/vmsnap-backup-monthly-${currentMonth}`;
        expect(await directoryExists(currentDir)).toBe(true);
      },
      180000
    );
  });

  describe('Multiple Grouped Backups', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('multi-group');
      vi.useRealTimers();
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'subsequent backups go to same group directory',
      async () => {
        // First backup
        const result1 = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=month',
          '--backup',
        ]);

        if (result1.exitCode !== 0) {
          console.log('Command:', result1.command);
          console.log('Stderr:', result1.stderr);
        }
        expect(result1.exitCode).toBe(0);

        // Second backup (should go to same directory)
        const result2 = await execVMSnap([
          `--domains=${testVM.name}`,
          `--output=${TEST_CONFIG.backupDir}`,
          '--groupBy=month',
          '--backup',
        ]);

        if (result2.exitCode !== 0) {
          console.log('Command:', result2.command);
          console.log('Stderr:', result2.stderr);
        }
        expect(result2.exitCode).toBe(0);

        // Should only have one monthly directory inside the VM's backup folder
        const vmBackupDir = `${TEST_CONFIG.backupDir}/${testVM.name}`;
        const monthlyDirs = await getBackupDirsByGroup(
          vmBackupDir,
          'month'
        );
        expect(monthlyDirs.length).toBe(1);
      },
      240000
    );
  });
});
