// Integration test helpers - consolidated exports
export { default as VMManager, TestVM, execVMSnap } from './vm-manager.js';

export {
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
} from './test-assertions.js';

export {
  cleanupBackupDir,
  ensureCleanBackupDir,
  cleanupTestVMs,
  cleanupTestFiles,
  fullCleanup,
  createMockBackup,
  cleanupLockFiles,
  verifyCleanEnvironment,
} from './cleanup-helpers.js';
