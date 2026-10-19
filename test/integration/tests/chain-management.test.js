import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import VMManager, {
  execVMSnap,
  checkLibvirtAvailable,
} from '../helpers/vm-manager.js';
import { getCheckpoints, listMatchingFiles } from '../helpers/test-assertions.js';
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

// Exit code for a groupBy that doesn't match the existing backups
const ERR_GROUPBY = 10;

let libvirtAvailable = false;

const runBackup = async (vm, output, extraArgs = []) => {
  const result = await execVMSnap([
    `--domains=${vm.name}`,
    `--output=${output}`,
    '--backup',
    ...extraArgs,
  ]);

  if (result.exitCode !== 0) {
    console.log('Command:', result.command);
    console.log('Stdout:', result.stdout);
    console.log('Stderr:', result.stderr);
  }

  return result;
};

describe('Backup Chain Management', () => {
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

  describe('Running VM Starting A New Chain', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('running-chain', { diskSize: '100M' });
      await testVM.start();
      await testVM.waitForState('running');
    }, 60000);

    afterAll(async () => {
      if (testVM && vmManager) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'removes checkpoints with their bitmaps when a new chain starts',
      async () => {
        const first = path.join(TEST_CONFIG.backupDir, 'first');
        const second = path.join(TEST_CONFIG.backupDir, 'second');

        expect((await runBackup(testVM, first, ['--groupBy=year'])).exitCode).toBe(0);
        expect(await getCheckpoints(testVM.name)).toEqual(['virtnbdbackup.0']);

        // A new output folder means a new chain, so the old checkpoint is
        // cleaned up before virtnbdbackup creates virtnbdbackup.0 again
        expect((await runBackup(testVM, second, ['--groupBy=year'])).exitCode).toBe(0);
        expect(await getCheckpoints(testVM.name)).toEqual(['virtnbdbackup.0']);
        expect(await testVM.getLiveBitmaps()).toEqual(['virtnbdbackup.0']);
      },
      240000
    );

    test(
      'removes orphaned bitmaps left by older versions from a running VM',
      async () => {
        // Simulate VMSnap 2.0.3 and earlier: metadata gone, bitmap left behind
        await testVM.orphanCheckpoint('virtnbdbackup.0');
        expect(await getCheckpoints(testVM.name)).toEqual([]);
        expect(await testVM.getLiveBitmaps()).toEqual(['virtnbdbackup.0']);

        const third = path.join(TEST_CONFIG.backupDir, 'third');

        // Previously failed with "Bitmap already exists: virtnbdbackup.0"
        expect((await runBackup(testVM, third, ['--groupBy=year'])).exitCode).toBe(0);
        expect(await getCheckpoints(testVM.name)).toEqual(['virtnbdbackup.0']);
      },
      240000
    );
  });

  describe('GroupBy Guard', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('groupby-guard', { diskSize: '100M' });
    }, 30000);

    afterAll(async () => {
      if (testVM && vmManager) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'refuses a different groupBy for the same output and keeps the chain',
      async () => {
        expect(
          (await runBackup(testVM, TEST_CONFIG.backupDir, ['--groupBy=year'])).exitCode
        ).toBe(0);
        expect(
          (await runBackup(testVM, TEST_CONFIG.backupDir, ['--groupBy=year'])).exitCode
        ).toBe(0);

        const checkpoints = await getCheckpoints(testVM.name);
        expect(checkpoints).toEqual(['virtnbdbackup.0', 'virtnbdbackup.1']);

        // No --groupBy means monthly, which doesn't match the yearly chain
        const result = await runBackup(testVM, TEST_CONFIG.backupDir);
        expect(result.exitCode).toBe(ERR_GROUPBY);
        expect(await getCheckpoints(testVM.name)).toEqual(checkpoints);
      },
      240000
    );

    test(
      'starts the new chain with --force',
      async () => {
        const result = await runBackup(testVM, TEST_CONFIG.backupDir, [
          '--groupBy=month',
          '--force',
        ]);

        expect(result.exitCode).toBe(0);
        expect(await getCheckpoints(testVM.name)).toEqual(['virtnbdbackup.0']);
      },
      240000
    );
  });

  describe('Copy Mode', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('copy-mode', { diskSize: '100M' });
    }, 30000);

    afterAll(async () => {
      if (testVM && vmManager) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'takes a copy alongside an existing chain without touching it',
      async () => {
        expect(
          (await runBackup(testVM, TEST_CONFIG.backupDir, ['--groupBy=bi-annual'])).exitCode
        ).toBe(0);
        const checkpoints = await getCheckpoints(testVM.name);
        expect(checkpoints).toEqual(['virtnbdbackup.0']);

        const result = await runBackup(testVM, TEST_CONFIG.backupDir, [
          '--groupBy=quarter',
          '--copy',
        ]);
        expect(result.exitCode).toBe(0);

        const vmDir = path.join(TEST_CONFIG.backupDir, testVM.name);
        const copies = await listMatchingFiles(vmDir, /^vmsnap-copy-quarterly-/);
        expect(copies.length).toBe(1);
        expect(
          (await listMatchingFiles(path.join(vmDir, copies[0]), /\.copy\.data$/)).length
        ).toBeGreaterThan(0);

        expect(await getCheckpoints(testVM.name)).toEqual(checkpoints);

        // The chain carries on incrementally after the copy
        expect(
          (await runBackup(testVM, TEST_CONFIG.backupDir, ['--groupBy=bi-annual'])).exitCode
        ).toBe(0);
        expect(await getCheckpoints(testVM.name)).toEqual([
          'virtnbdbackup.0',
          'virtnbdbackup.1',
        ]);
      },
      300000
    );

    test(
      'skips a second copy in the same period',
      async () => {
        const result = await runBackup(testVM, TEST_CONFIG.backupDir, [
          '--groupBy=quarter',
          '--copy',
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('already exists for this period');
      },
      120000
    );
  });
});
