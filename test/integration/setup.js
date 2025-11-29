import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import VMManager from './helpers/vm-manager.js';
import {
  fullCleanup,
  ensureCleanBackupDir,
  cleanupLockFiles,
} from './helpers/cleanup-helpers.js';

// Shared VM manager instance for tests
export let vmManager;

// Test configuration
export const TEST_CONFIG = {
  testDir: '/tmp/vmsnap-integration-test',
  backupDir: '/tmp/vmsnap-integration-test/backups',
  vmPrefix: 'vmsnap-test',
  timeout: 120000, // 2 minutes per test
};

// Setup before all integration tests
beforeAll(async () => {
  // Clean up any leftover state from previous runs
  await fullCleanup({
    testDir: TEST_CONFIG.testDir,
    vmPrefix: TEST_CONFIG.vmPrefix,
  });

  // Create VM manager
  vmManager = new VMManager({
    testDir: TEST_CONFIG.testDir,
    vmPrefix: TEST_CONFIG.vmPrefix,
  });

  // Initialize test environment
  await vmManager.setup();

  // Ensure clean backup directory
  await ensureCleanBackupDir(TEST_CONFIG.backupDir);
}, 60000);

// Cleanup after all integration tests
afterAll(async () => {
  if (vmManager) {
    await vmManager.cleanup();
  }

  // Full cleanup
  await fullCleanup({
    testDir: TEST_CONFIG.testDir,
    vmPrefix: TEST_CONFIG.vmPrefix,
    removeTestDir: true,
  });
}, 60000);

// Cleanup lock files before each test
beforeEach(async () => {
  await cleanupLockFiles();
});

// Cleanup after each test
afterEach(async () => {
  await cleanupLockFiles();
});

export default {
  vmManager,
  TEST_CONFIG,
};
