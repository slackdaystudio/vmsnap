import { describe, test, expect, vi, beforeEach } from 'vitest';
import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat.js';
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js';
import dayOfYear from 'dayjs/plugin/dayOfYear.js';

import { getBackupFolder } from '../../../libs/libnbdbackup.js';

// Setup dayjs plugins
dayjs.extend(advancedFormat);
dayjs.extend(quarterOfYear);
dayjs.extend(dayOfYear);

// Mock dependencies for isolated testing
vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

vi.mock('fs/promises', () => ({
  rm: vi.fn()
}));

vi.mock('../../../vmsnap.js', () => ({
  ERR_DOMAINS: 1,
  ERR_OUTPUT_DIR: 2,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('../../../libs/virsh.js', () => ({
  cleanupCheckpoints: vi.fn(),
  domainExists: vi.fn(),
  isDomainRunning: vi.fn(),
  fetchAllDomains: vi.fn()
}));

vi.mock('../../../libs/general.js', () => ({
  fileExists: vi.fn(),
  parseArrayParam: vi.fn(),
  createError: vi.fn((message, code) => {
    const err = new Error(message);
    err.code = code;
    return err;
  }),
}));

vi.mock('../../../libs/qemu-img.js', () => ({
  cleanupBitmaps: vi.fn()
}));

describe('libnbdbackup.js edge cases', () => {
  let childProcessModule, fsModule, vmSnapModule, virshModule, generalModule, qemuImgModule;
  let mockSpawnChild;

  beforeEach(async () => {
    vi.clearAllMocks();

    childProcessModule = await import('child_process');
    fsModule = await import('fs/promises');
    vmSnapModule = await import('../../../vmsnap.js');
    virshModule = await import('../../../libs/virsh.js');
    generalModule = await import('../../../libs/general.js');
    qemuImgModule = await import('../../../libs/qemu-img.js');

    // Setup default mock for isDomainRunning
    virshModule.isDomainRunning.mockResolvedValue(true);

    // Setup mock spawn child process
    mockSpawnChild = {
      stdout: null, // This will trigger the uncovered null check
      stderr: {
        setEncoding: vi.fn(),
        on: vi.fn()
      },
      on: vi.fn()
    };

    childProcessModule.spawn.mockReturnValue(mockSpawnChild);
  });

  describe('uncovered backup scenarios', () => {
    test('handles backup process without stdout stream', async () => {
      // This targets the uncovered lines around child.stdout null check
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.stdout = null; // No stdout stream
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      // Verify stderr was still set up
      expect(mockSpawnChild.stderr.setEncoding).toHaveBeenCalledWith('utf8');
      expect(mockSpawnChild.stderr.on).toHaveBeenCalledWith('data', expect.any(Function));
    });

    test('handles backup process without stderr stream', async () => {
      // Test the null check for stderr
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.stdout = {
        setEncoding: vi.fn(),
        on: vi.fn()
      };
      mockSpawnChild.stderr = null; // No stderr stream
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      // Verify stdout was still set up
      expect(mockSpawnChild.stdout.setEncoding).toHaveBeenCalledWith('utf8');
      expect(mockSpawnChild.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
    });

    test('handles backup process with both stdout and stderr data', async () => {
      // Test the data event handlers for stdout and stderr
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.stdout = {
        setEncoding: vi.fn(),
        on: vi.fn()
      };
      mockSpawnChild.stderr = {
        setEncoding: vi.fn(),
        on: vi.fn()
      };
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      // Verify data handlers were set up and can be called
      const stdoutDataHandler = mockSpawnChild.stdout.on.mock.calls.find(
        call => call[0] === 'data'
      )[1];
      const stderrDataHandler = mockSpawnChild.stderr.on.mock.calls.find(
        call => call[0] === 'data'
      )[1];

      // Call the handlers to trigger the uncovered lines
      stdoutDataHandler('Backup progress: 50%');
      stderrDataHandler('Warning: some warning message');

      expect(vmSnapModule.logger.info).toHaveBeenCalledWith('Backup progress: 50%');
      expect(vmSnapModule.logger.error).toHaveBeenCalledWith('Warning: some warning message');
    });
  });

  describe('pruning edge cases', () => {
    test('handles undefined previous backup folder during pruning', async () => {
      // This targets line 240 in libnbdbackup.js
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      // Set date to trigger pruning
      vi.setSystemTime(new Date('2024-03-20T10:00:00Z'));
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists
        .mockResolvedValueOnce(true)  // Current folder exists
        .mockResolvedValueOnce(false); // Previous folder doesn't exist
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      // Test with an invalid groupBy that returns undefined backup folder
      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'invalid-group',
        prune: true
      });

      // Should skip pruning due to invalid groupBy
      expect(vmSnapModule.logger.warn).toHaveBeenCalledWith(
        'Invalid groupBy: invalid-group.  Pruning disabled'
      );
      expect(fsModule.rm).not.toHaveBeenCalled();
    });

    test('successfully prunes previous backup when conditions are met', async () => {
      // Test the successful pruning path including line 232 return
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      vi.setSystemTime(new Date('2024-03-20T10:00:00Z')); // Past middle of month
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists
        .mockResolvedValueOnce(true)  // Current folder exists
        .mockResolvedValueOnce(true); // Previous folder exists
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: true
      });

      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Pruning monthly backup')
      );
      expect(fsModule.rm).toHaveBeenCalled();
    });
  });

  describe('getBackupStartDate edge cases', () => {
    test('handles bi-annual groupBy for backup start date', async () => {
      // Import the internal function to test directly
      const { default: libnbdbackup } = await vi.importActual('../../../libs/libnbdbackup.js');
      
      // Test bi-annual handling (line 262-263)
      vi.setSystemTime(new Date('2024-07-15T10:00:00Z')); // July
      
      // We can't easily test the internal function, but we can test through performBackup
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      vi.setSystemTime(new Date('2024-07-20T10:00:00Z')); // Past 90 days from start of year
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists
        .mockResolvedValueOnce(true)  // Current folder exists
        .mockResolvedValueOnce(true); // Previous folder exists
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'bi-annual',
        prune: true
      });

      // Should trigger pruning for bi-annual
      expect(fsModule.rm).toHaveBeenCalled();
    });

    test('falls back to monthly for invalid groupBy in backup start date', async () => {
      // This tests line 269 - the fallback to FREQUENCY_MONTHLY
      vi.setSystemTime(new Date('2024-03-20T10:00:00Z'));
      
      const { performBackup } = await import('../../../libs/libnbdbackup.js');
      
      generalModule.parseArrayParam.mockResolvedValue(['test-vm']);
      virshModule.domainExists.mockResolvedValue(true);
      generalModule.fileExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false); // Previous folder doesn't exist
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-vm',
        output: '/backup',
        raw: false,
        groupBy: 'totally-invalid',
        prune: true
      });

      // Should log invalid groupBy warning
      expect(vmSnapModule.logger.warn).toHaveBeenCalledWith(
        'Invalid groupBy: totally-invalid.  Pruning disabled'
      );
    });
  });

  describe('getBackupFolder edge cases', () => {
    test('returns undefined for completely invalid groupBy', () => {
      vi.setSystemTime(new Date('2024-03-15T10:00:00Z'));
      
      const result = getBackupFolder('completely-invalid');
      expect(result).toBeUndefined();
    });

    test('handles edge case dates for bi-annual grouping', () => {
      // Test exactly on day 180 boundary
      vi.setSystemTime(new Date('2024-06-29T10:00:00Z')); // Day 181 of 2024 (past 180)
      
      const current = getBackupFolder('bi-annual', true);
      const previous = getBackupFolder('bi-annual', false);
      
      expect(current).toBe('vmsnap-backup-bi-annually-2024-p2');
      expect(previous).toBe('vmsnap-backup-bi-annually-2023-p1'); // Previous goes to p1 when current is p2
    });

    test('handles leap year day calculations for bi-annual', () => {
      // Test in leap year
      vi.setSystemTime(new Date('2024-12-31T10:00:00Z')); // End of leap year
      
      const result = getBackupFolder('bi-annual', true);
      expect(result).toBe('vmsnap-backup-bi-annually-2024-p2');
    });

    test('handles year transitions for all groupBy types', () => {
      vi.setSystemTime(new Date('2024-01-01T10:00:00Z')); // Start of year
      
      const monthly = getBackupFolder('month', false);
      const quarterly = getBackupFolder('quarter', false);
      const yearly = getBackupFolder('year', false);
      
      expect(monthly).toBe('vmsnap-backup-monthly-2023-12');
      expect(quarterly).toBe('vmsnap-backup-quarterly-2023-Q4');
      expect(yearly).toBe('vmsnap-backup-yearly-2023');
    });
  });
});