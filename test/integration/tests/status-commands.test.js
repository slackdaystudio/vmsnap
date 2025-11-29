import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import VMManager, {
  execVMSnap,
  checkLibvirtAvailable,
} from '../helpers/vm-manager.js';
import { parseVMSnapJSON } from '../helpers/test-assertions.js';
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

describe('Status and Information Commands', () => {
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

  describe('Basic Status Output', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('status-basic');

      // Create a backup first
      const result = await execVMSnap([
        `--domains=${testVM.name}`,
        `--output=${TEST_CONFIG.backupDir}`,
        '--backup',
      ]);

      if (result.exitCode !== 0) {
        console.log('Command:', result.command);
        console.log('Stderr:', result.stderr);
      }
    }, 180000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'displays VM status correctly',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
        ]);

        expect(result.exitCode).toBe(0);

        // Should contain status information
        const output = result.stdout.toLowerCase();
        expect(
          output.includes('status') ||
            output.includes('checkpoint') ||
            output.includes(testVM.name.toLowerCase())
        ).toBe(true);
      },
      30000
    );

    test(
      'shows checkpoint information',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
        ]);

        expect(result.exitCode).toBe(0);

        // Should mention checkpoints or virtnbdbackup
        expect(
          result.stdout.includes('virtnbdbackup') ||
            result.stdout.includes('checkpoint') ||
            result.stdout.includes('Checkpoint')
        ).toBe(true);
      },
      30000
    );
  });

  describe('JSON Output Format', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('status-json');

      // Create a backup first
      const result = await execVMSnap([
        `--domains=${testVM.name}`,
        `--output=${TEST_CONFIG.backupDir}`,
        '--backup',
      ]);

      if (result.exitCode !== 0) {
        console.log('Command:', result.command);
        console.log('Stderr:', result.stderr);
      }
    }, 180000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'outputs valid JSON with --json flag',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
          '--json',
        ]);

        expect(result.exitCode).toBe(0);

        // Should be valid JSON
        const parsed = parseVMSnapJSON(result.stdout);
        expect(parsed).not.toBeNull();
      },
      30000
    );

    test(
      'JSON contains expected properties',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
          '--json',
        ]);

        expect(result.exitCode).toBe(0);

        const parsed = parseVMSnapJSON(result.stdout);
        expect(parsed).not.toBeNull();

        // Check for VM entry
        expect(parsed).toHaveProperty(testVM.name);

        const vmStatus = parsed[testVM.name];
        // Should have basic properties
        expect(vmStatus).toBeDefined();
      },
      30000
    );
  });

  describe('Machine-Readable Output', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM = await vmManager.createTestVM('status-machine');

      // Create a backup first
      const result = await execVMSnap([
        `--domains=${testVM.name}`,
        `--output=${TEST_CONFIG.backupDir}`,
        '--backup',
      ]);

      if (result.exitCode !== 0) {
        console.log('Command:', result.command);
        console.log('Stderr:', result.stderr);
      }
    }, 180000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'outputs machine-readable format with --machine flag',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
          '--json',
          '--machine',
        ]);

        expect(result.exitCode).toBe(0);

        // Should be valid JSON (machine format is typically JSON)
        const parsed = parseVMSnapJSON(result.stdout);
        expect(parsed).not.toBeNull();
      },
      30000
    );
  });

  describe('Status for Multiple VMs', () => {
    let testVM1;
    let testVM2;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      await ensureCleanBackupDir(TEST_CONFIG.backupDir);
      testVM1 = await vmManager.createTestVM('status-multi-1');
      testVM2 = await vmManager.createTestVM('status-multi-2');

      // Create backups for both
      const result1 = await execVMSnap([
        `--domains=${testVM1.name}`,
        `--output=${TEST_CONFIG.backupDir}`,
        '--backup',
      ]);

      if (result1.exitCode !== 0) {
        console.log('Command:', result1.command);
        console.log('Stderr:', result1.stderr);
      }

      const result2 = await execVMSnap([
        `--domains=${testVM2.name}`,
        `--output=${TEST_CONFIG.backupDir}`,
        '--backup',
      ]);

      if (result2.exitCode !== 0) {
        console.log('Command:', result2.command);
        console.log('Stderr:', result2.stderr);
      }
    }, 300000);

    afterAll(async () => {
      if (testVM1) await vmManager.destroyVM(testVM1);
      if (testVM2) await vmManager.destroyVM(testVM2);
    }, 60000);

    test(
      'shows status for multiple VMs',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM1.name},${testVM2.name}`,
          '--status',
        ]);

        expect(result.exitCode).toBe(0);

        // Output should reference both VMs
        expect(result.stdout.includes(testVM1.name) || result.stdout.includes('multi-1')).toBe(true);
        expect(result.stdout.includes(testVM2.name) || result.stdout.includes('multi-2')).toBe(true);
      },
      30000
    );

    test(
      'JSON output contains all VMs',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM1.name},${testVM2.name}`,
          '--status',
          '--json',
        ]);

        expect(result.exitCode).toBe(0);

        const parsed = parseVMSnapJSON(result.stdout);
        expect(parsed).not.toBeNull();

        expect(parsed).toHaveProperty(testVM1.name);
        expect(parsed).toHaveProperty(testVM2.name);
      },
      30000
    );
  });

  describe('Status Without Prior Backup', () => {
    let testVM;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      testVM = await vmManager.createTestVM('status-no-backup');
    }, 30000);

    afterAll(async () => {
      if (testVM) {
        await vmManager.destroyVM(testVM);
      }
    }, 30000);

    test(
      'handles VM with no checkpoints gracefully',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
        ]);

        // Should complete without error
        expect(result.exitCode).toBe(0);
      },
      30000
    );

    test(
      'JSON output valid for VM without checkpoints',
      async () => {
        const result = await execVMSnap([
          `--domains=${testVM.name}`,
          '--status',
          '--json',
        ]);

        expect(result.exitCode).toBe(0);

        const parsed = parseVMSnapJSON(result.stdout);
        expect(parsed).not.toBeNull();
        expect(parsed).toHaveProperty(testVM.name);
      },
      30000
    );
  });

  describe('Wildcard Status', () => {
    let wildcardVM1;
    let wildcardVM2;

    beforeAll(async () => {
      if (!libvirtAvailable) return;
      await cleanupLockFiles();
      wildcardVM1 = await vmManager.createTestVM('status-wild-a');
      wildcardVM2 = await vmManager.createTestVM('status-wild-b');
    }, 60000);

    afterAll(async () => {
      if (wildcardVM1) await vmManager.destroyVM(wildcardVM1);
      if (wildcardVM2) await vmManager.destroyVM(wildcardVM2);
    }, 60000);

    test(
      'shows status for VMs matching wildcard pattern',
      async () => {
        const result = await execVMSnap([
          '--domains=vmsnap-test-status-wild-*',
          '--status',
        ]);

        expect(result.exitCode).toBe(0);

        // Should include both VMs
        expect(
          result.stdout.includes('wild-a') && result.stdout.includes('wild-b')
        ).toBe(true);
      },
      30000
    );
  });
});
