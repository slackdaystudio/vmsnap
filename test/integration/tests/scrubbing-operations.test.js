import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import VMManager, {
  execVMSnap,
  checkLibvirtAvailable,
} from '../helpers/vm-manager.js';
import { getCheckpoints, getBitmaps } from '../helpers/test-assertions.js';
import {
  ensureCleanBackupDir,
  fullCleanup,
  cleanupLockFiles,
} from '../helpers/cleanup-helpers.js';

const TEST_CONFIG = {
  testDir: '/tmp/vmsnap-integration-test',
  backupDir: '/tmp/vmsnap-integration-test/backups',
  vmPrefix: 'vmsnap-test',
};

// Track if libvirt is available
let libvirtAvailable = false;

describe('Scrubbing Operations', () => {
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
  }, 60000);

  beforeEach(async (context) => {
    if (!libvirtAvailable) {
      context.skip();
    }
  });

  describe('Checkpoint Scrubbing', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('scrub-checkpoint');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'creates checkpoints during backup',
      async () => {
        // Create multiple backups to generate checkpoints
        for (let i = 0; i < 2; i++) {
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
        }

        // Note: Offline VMs don't create checkpoints - they use copy mode
        const checkpoints = await getCheckpoints(testVM.name);
        const state = await testVM.getState();
        if (state === 'shut off') {
          expect(checkpoints.length).toBe(0);
        } else {
          expect(checkpoints.length).toBe(2);
        }
      },
      240000
    );

    test(
      'scrubs specific checkpoint by name',
      async () => {
        const checkpointsBefore = await getCheckpoints(testVM.name);

        // Skip test if no checkpoints (offline VMs don't create them)
        if (checkpointsBefore.length === 0) {
          console.log('Skipping: No checkpoints created (VM is offline)');
          return;
        }

        expect(checkpointsBefore.length).toBeGreaterThanOrEqual(1);

        // Get the first checkpoint name
        const checkpointToDelete = checkpointsBefore[0];

        // Scrub the specific checkpoint
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--scrub',
          '--scrubType=checkpoint',
          `--checkpointName=${checkpointToDelete}`,
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Verify checkpoint was removed
        const checkpointsAfter = await getCheckpoints(testVM.name);
        expect(checkpointsAfter).not.toContain(checkpointToDelete);
        expect(checkpointsAfter.length).toBe(checkpointsBefore.length - 1);
      },
      60000
    );
  });

  describe('Scrub All Checkpoints', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('scrub-all-checkpoints');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'scrubs all checkpoints with wildcard',
      async () => {
        // Create backups to generate checkpoints
        for (let i = 0; i < 2; i++) {
          await execVMSnap([
            `--domains=${testVM.name}`,
            `--output=${TEST_CONFIG.backupDir}`,
            '--backup',
          ]);
        }

        // Check checkpoints (offline VMs don't create them)
        const checkpointsBefore = await getCheckpoints(testVM.name);

        // Skip test if no checkpoints (offline VMs don't create them)
        if (checkpointsBefore.length === 0) {
          console.log('Skipping: No checkpoints created (VM is offline)');
          return;
        }

        expect(checkpointsBefore.length).toBeGreaterThanOrEqual(1);

        // Scrub all checkpoints
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--scrub',
          '--scrubType=checkpoint',
          '--checkpointName=*',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Verify all checkpoints were removed
        const checkpointsAfter = await getCheckpoints(testVM.name);
        expect(checkpointsAfter.length).toBe(0);
      },
      300000
    );
  });

  describe('Bitmap Scrubbing', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('scrub-bitmap');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'scrubs all bitmaps',
      async () => {
        // Create backups to generate bitmaps
        for (let i = 0; i < 2; i++) {
          await execVMSnap([
            `--domains=${testVM.name}`,
            `--output=${TEST_CONFIG.backupDir}`,
            '--backup',
          ]);
        }

        // Get bitmaps (they're on the disk image)
        const bitmapsBefore = await getBitmaps(testVM.diskPath);
        // Note: Bitmaps might not always be created for offline VMs

        // Scrub all bitmaps
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--scrub',
          '--scrubType=bitmap',
          '--bitmapName=*',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Verify bitmaps were removed
        const bitmapsAfter = await getBitmaps(testVM.diskPath);
        expect(bitmapsAfter.length).toBe(0);
      },
      300000
    );
  });

  describe('Full Scrub (Everything)', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('scrub-everything');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'scrubs all checkpoints and bitmaps with scrubType=*',
      async () => {
        // Create backups to generate checkpoints and bitmaps
        for (let i = 0; i < 2; i++) {
          await execVMSnap([
            `--domains=${testVM.name}`,
            `--output=${TEST_CONFIG.backupDir}`,
            '--backup',
          ]);
        }

        // Check checkpoints (offline VMs don't create them)
        const checkpointsBefore = await getCheckpoints(testVM.name);

        // Skip test if no checkpoints (offline VMs don't create them)
        if (checkpointsBefore.length === 0) {
          console.log('Skipping: No checkpoints created (VM is offline)');
          return;
        }

        expect(checkpointsBefore.length).toBeGreaterThanOrEqual(1);

        // Scrub everything
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--scrub',
          '--scrubType=*',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Verify everything was cleaned up
        const checkpointsAfter = await getCheckpoints(testVM.name);
        const bitmapsAfter = await getBitmaps(testVM.diskPath);

        expect(checkpointsAfter.length).toBe(0);
        expect(bitmapsAfter.length).toBe(0);
      },
      360000
    );
  });

  describe('Scrub with Multiple VMs', () => {
    let testVM1;
    let testVM2;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM1 = await vmManager.createTestVM('scrub-multi-1');
      testVM2 = await vmManager.createTestVM('scrub-multi-2');
    }, 60000);

    afterAll(async () => {
      if (testVM1) await vmManager.destroyVM(testVM1);
      if (testVM2) await vmManager.destroyVM(testVM2);
    }, 60000);

    test(
      'scrubs checkpoints from multiple VMs',
      async () => {
        // Create backups for both VMs
        for (const vm of [testVM1, testVM2]) {
          await execVMSnap([
            `--domains=${vm.name}`,
            `--output=${TEST_CONFIG.backupDir}`,
            '--backup',
          ]);
        }

        // Check checkpoints (offline VMs don't create them)
        const checkpoints1Before = await getCheckpoints(testVM1.name);
        const checkpoints2Before = await getCheckpoints(testVM2.name);

        // Skip test if no checkpoints (offline VMs don't create them)
        if (checkpoints1Before.length === 0 && checkpoints2Before.length === 0) {
          console.log('Skipping: No checkpoints created (VMs are offline)');
          return;
        }

        // Scrub checkpoints from both
        const result = await execVMSnap([
          `--domains=${testVM1.name},${testVM2.name}`,
          '--scrub',
          '--scrubType=checkpoint',
          '--checkpointName=*',
        ]);

        if (result.exitCode !== 0) {
          console.log('Command:', result.command);
          console.log('Stderr:', result.stderr);
        }

        expect(result.exitCode).toBe(0);

        // Verify checkpoints removed from both
        expect((await getCheckpoints(testVM1.name)).length).toBe(0);
        expect((await getCheckpoints(testVM2.name)).length).toBe(0);
      },
      360000
    );
  });
});
