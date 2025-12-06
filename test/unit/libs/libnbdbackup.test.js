import { describe, test, expect, vi, beforeEach } from 'vitest';
import { sep } from 'path';
import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat.js';
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js';
import dayOfYear from 'dayjs/plugin/dayOfYear.js';

import {
  BACKUP,
  FREQUENCY_MONTHLY,
  getBackupFolder,
  performBackup
} from '../../../libs/libnbdbackup.js';

// Setup dayjs plugins for tests
dayjs.extend(advancedFormat);
dayjs.extend(quarterOfYear);
dayjs.extend(dayOfYear);

// Mock external dependencies
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

describe('libnbdbackup.js', () => {
  let childProcessModule, fsModule, vmSnapModule, virshModule, generalModule, qemuImgModule;
  let mockSpawnChild;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Set a fixed date for consistent testing (March 15, 2024)
    vi.setSystemTime(new Date('2024-03-15T10:00:00Z'));
    
    childProcessModule = await import('child_process');
    fsModule = await import('fs/promises');
    vmSnapModule = await import('../../../vmsnap.js');
    virshModule = await import('../../../libs/virsh.js');
    generalModule = await import('../../../libs/general.js');
    qemuImgModule = await import('../../../libs/qemu-img.js');

    // Setup mock spawn child process
    mockSpawnChild = {
      stdout: {
        setEncoding: vi.fn(),
        on: vi.fn()
      },
      stderr: {
        setEncoding: vi.fn(),
        on: vi.fn()
      },
      on: vi.fn()
    };
    
    childProcessModule.spawn.mockReturnValue(mockSpawnChild);
  });

  describe('constants', () => {
    test('exports correct BACKUP constant', () => {
      expect(BACKUP).toBe('virtnbdbackup');
    });

    test('exports correct FREQUENCY_MONTHLY constant', () => {
      expect(FREQUENCY_MONTHLY).toBe('month');
    });
  });

  describe('getBackupFolder', () => {
    describe('monthly grouping', () => {
      test('returns current month folder name', () => {
        const result = getBackupFolder('month', true);
        expect(result).toBe('vmsnap-backup-monthly-2024-03');
      });

      test('returns previous month folder name', () => {
        const result = getBackupFolder('month', false);
        expect(result).toBe('vmsnap-backup-monthly-2024-02');
      });

      test('handles year boundary for previous month', () => {
        vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));
        
        const result = getBackupFolder('month', false);
        expect(result).toBe('vmsnap-backup-monthly-2023-12');
      });
    });

    describe('quarterly grouping', () => {
      test('returns current quarter folder name', () => {
        const result = getBackupFolder('quarter', true);
        expect(result).toBe('vmsnap-backup-quarterly-2024-Q1');
      });

      test('returns previous quarter folder name', () => {
        const result = getBackupFolder('quarter', false);
        expect(result).toBe('vmsnap-backup-quarterly-2023-Q4');
      });

      test('handles different quarters correctly', () => {
        vi.setSystemTime(new Date('2024-07-15T10:00:00Z')); // Q3
        
        const current = getBackupFolder('quarter', true);
        const previous = getBackupFolder('quarter', false);
        
        expect(current).toBe('vmsnap-backup-quarterly-2024-Q3');
        expect(previous).toBe('vmsnap-backup-quarterly-2024-Q2');
      });
    });

    describe('bi-annual grouping', () => {
      test('returns first half folder name (before day 180)', () => {
        vi.setSystemTime(new Date('2024-03-15T10:00:00Z')); // Day 75
        
        const result = getBackupFolder('bi-annual', true);
        expect(result).toBe('vmsnap-backup-bi-annually-2024-p1');
      });

      test('returns second half folder name (after day 180)', () => {
        vi.setSystemTime(new Date('2024-07-15T10:00:00Z')); // Day 197
        
        const result = getBackupFolder('bi-annual', true);
        expect(result).toBe('vmsnap-backup-bi-annually-2024-p2');
      });

      test('returns previous period for first half', () => {
        vi.setSystemTime(new Date('2024-03-15T10:00:00Z')); // Day 75, p1
        
        const result = getBackupFolder('bi-annual', false);
        expect(result).toBe('vmsnap-backup-bi-annually-2023-p2');
      });

      test('returns previous period for second half', () => {
        vi.setSystemTime(new Date('2024-07-15T10:00:00Z')); // Day 197, p2
        
        const result = getBackupFolder('bi-annual', false);
        expect(result).toBe('vmsnap-backup-bi-annually-2024-p1');
      });
    });

    describe('yearly grouping', () => {
      test('returns current year folder name', () => {
        const result = getBackupFolder('year', true);
        expect(result).toBe('vmsnap-backup-yearly-2024');
      });

      test('returns previous year folder name', () => {
        const result = getBackupFolder('year', false);
        expect(result).toBe('vmsnap-backup-yearly-2023');
      });
    });

    describe('default and invalid inputs', () => {
      test('defaults to monthly when no groupBy provided', () => {
        const result = getBackupFolder();
        expect(result).toBe('vmsnap-backup-monthly-2024-03');
      });

      test('returns undefined for invalid groupBy', () => {
        const result = getBackupFolder('invalid');
        expect(result).toBeUndefined();
      });
    });
  });

  describe('performBackup', () => {
    beforeEach(() => {
      // Setup default mocks
      generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
      virshModule.domainExists.mockResolvedValue(true);
      virshModule.isDomainRunning.mockResolvedValue(true); // Default to running VM
      generalModule.fileExists.mockResolvedValue(false); // No existing backup folder
    });

    test('throws error when no domains specified', async () => {
      await expect(performBackup({ domains: null, output: '/backup' }))
        .rejects.toThrow('No domains specified');
    });

    test('throws error when no output directory specified', async () => {
      await expect(performBackup({ domains: 'test-domain', output: null }))
        .rejects.toThrow('No output directory specified');
    });

    test('performs cleanup when backup folder does not exist', async () => {
      generalModule.fileExists.mockResolvedValue(false);
      
      // Mock spawn to resolve immediately
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(virshModule.cleanupCheckpoints).toHaveBeenCalledWith('test-domain');
      expect(qemuImgModule.cleanupBitmaps).toHaveBeenCalledWith('test-domain');
      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'Creating a new backup directory, running bitmap cleanup'
      );
    });

    test('skips cleanup when backup folder exists', async () => {
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(virshModule.cleanupCheckpoints).not.toHaveBeenCalled();
      expect(qemuImgModule.cleanupBitmaps).not.toHaveBeenCalled();
    });

    test('performs pruning when conditions are met', async () => {
      // Set date to middle of month (day 20) to trigger pruning
      vi.setSystemTime(new Date('2024-03-20T10:00:00Z'));
      
      generalModule.fileExists
        .mockResolvedValueOnce(true)  // Current backup folder exists
        .mockResolvedValueOnce(true); // Previous backup folder exists
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: 'month'
      });

      expect(fsModule.rm).toHaveBeenCalledWith(
        '/backup/test-domain/vmsnap-backup-monthly-2024-02',
        { recursive: true, force: true }
      );
      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'Middle of the current backup window, running a cleanup on old backups'
      );
    });

    test('skips pruning when before middle of period', async () => {
      // Set date to early in month (day 10) to skip pruning
      vi.setSystemTime(new Date('2024-03-10T10:00:00Z'));
      
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: 'month'
      });

      expect(fsModule.rm).not.toHaveBeenCalled();
    });

    test('skips pruning when prune is false', async () => {
      vi.setSystemTime(new Date('2024-03-20T10:00:00Z')); // Past middle of month
      
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(fsModule.rm).not.toHaveBeenCalled();
    });

    test('handles multiple domains', async () => {
      generalModule.parseArrayParam.mockResolvedValue(['domain1', 'domain2']);
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'domain1,domain2',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(childProcessModule.spawn).toHaveBeenCalledTimes(2);
    });

    test('spawns backup process with correct arguments', async () => {
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        'virtnbdbackup',
        [
          '--noprogress',
          '-d',
          'test-domain',
          '-l',
          'auto',
          '-o',
          `/backup${sep}test-domain${sep}vmsnap-backup-monthly-2024-03`
        ],
        {
          uid: 0,
          gid: 0,
          stdio: 'inherit'
        }
      );
    });

    test('spawns backup process with raw flag when specified', async () => {
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: true,
        groupBy: 'month',
        prune: false
      });

      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        'virtnbdbackup',
        expect.arrayContaining(['--raw']),
        expect.any(Object)
      );
    });

    test('skips backup for non-existent domain', async () => {
      virshModule.domainExists.mockResolvedValue(false);
      generalModule.fileExists.mockResolvedValue(true);

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(vmSnapModule.logger.warn).toHaveBeenCalledWith('test-domain does not exist');
      expect(childProcessModule.spawn).not.toHaveBeenCalled();
    });

    test('adds -S flag for offline VMs to enable checkpoint creation', async () => {
      virshModule.isDomainRunning.mockResolvedValue(false); // VM is offline
      generalModule.fileExists.mockResolvedValue(true);

      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'test-domain is offline, starting in paused state for checkpoint backup'
      );
      expect(childProcessModule.spawn).toHaveBeenCalledWith(
        'virtnbdbackup',
        expect.arrayContaining(['-S']),
        expect.any(Object)
      );
    });

    test('does not add -S flag for running VMs', async () => {
      virshModule.isDomainRunning.mockResolvedValue(true); // VM is running
      generalModule.fileExists.mockResolvedValue(true);

      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      const spawnCall = childProcessModule.spawn.mock.calls[0];
      expect(spawnCall[1]).not.toContain('-S');
    });

    test('logs error when backup fails', async () => {
      generalModule.fileExists.mockResolvedValue(true);
      
      // Mock backup failure (exit code 1)
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(1), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(vmSnapModule.logger.error).toHaveBeenCalledWith(
        'Backup for test-domain failed with code 1'
      );
    });

    test('handles stdout data from backup process', async () => {
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(mockSpawnChild.stdout.setEncoding).toHaveBeenCalledWith('utf8');
      expect(mockSpawnChild.stdout.on).toHaveBeenCalledWith('data', expect.any(Function));
    });

    test('handles stderr data from backup process', async () => {
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });

      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: false
      });

      expect(mockSpawnChild.stderr.setEncoding).toHaveBeenCalledWith('utf8');
      expect(mockSpawnChild.stderr.on).toHaveBeenCalledWith('data', expect.any(Function));
    });
  });

  describe('pruning logic', () => {
    describe('monthly pruning thresholds', () => {
      test('requires pruning after day 15 of month', async () => {
        vi.setSystemTime(new Date('2024-03-16T10:00:00Z'));
        
        generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
        generalModule.fileExists
          .mockResolvedValueOnce(true)  // Current folder exists
          .mockResolvedValueOnce(true); // Previous folder exists
        
        mockSpawnChild.on.mockImplementation((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        });
        
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        
        await performBackup({
          domains: 'test-domain',
          output: '/backup',
          raw: false,
          groupBy: 'month',
          prune: 'month'
        });
        
        expect(fsModule.rm).toHaveBeenCalled();
        spy.mockRestore();
      });

      test('skips pruning before day 15 of month', async () => {
        vi.setSystemTime(new Date('2024-03-14T10:00:00Z'));
        
        generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
        generalModule.fileExists
          .mockResolvedValueOnce(true)  // Current folder exists
          .mockResolvedValueOnce(true); // Previous folder exists
        
        mockSpawnChild.on.mockImplementation((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        });
        
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        
        await performBackup({
          domains: 'test-domain',
          output: '/backup',
          raw: false,
          groupBy: 'month',
          prune: 'month'
        });
        
        expect(fsModule.rm).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    describe('quarterly pruning thresholds', () => {
      test('requires pruning after 45 days into quarter', async () => {
        // Q1 2024 starts Jan 1, so 45 days later is ~Feb 15
        vi.setSystemTime(new Date('2024-02-16T10:00:00Z'));
        
        generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
        generalModule.fileExists
          .mockResolvedValueOnce(true)  // Current folder exists
          .mockResolvedValueOnce(true); // Previous folder exists
        
        mockSpawnChild.on.mockImplementation((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        });
        
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        
        await performBackup({
          domains: 'test-domain',
          output: '/backup',
          raw: false,
          groupBy: 'quarter',
          prune: 'quarter'
        });
        
        expect(fsModule.rm).toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    describe('bi-annual pruning thresholds', () => {
      test('requires pruning after 90 days into bi-annual period', async () => {
        // For bi-annual starting in January, 90 days is around April 1
        vi.setSystemTime(new Date('2024-04-02T10:00:00Z'));
        
        generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
        generalModule.fileExists
          .mockResolvedValueOnce(true)  // Current folder exists
          .mockResolvedValueOnce(true); // Previous folder exists
        
        mockSpawnChild.on.mockImplementation((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        });
        
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        
        await performBackup({
          domains: 'test-domain',
          output: '/backup',
          raw: false,
          groupBy: 'bi-annual',
          prune: 'bi-annual'
        });
        
        expect(fsModule.rm).toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    describe('yearly pruning thresholds', () => {
      test('requires pruning after 180 days into year', async () => {
        // 180 days from Jan 1 is around June 29
        vi.setSystemTime(new Date('2024-06-30T10:00:00Z'));
        
        generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
        generalModule.fileExists
          .mockResolvedValueOnce(true)  // Current folder exists
          .mockResolvedValueOnce(true); // Previous folder exists
        
        mockSpawnChild.on.mockImplementation((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        });
        
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        
        await performBackup({
          domains: 'test-domain',
          output: '/backup',
          raw: false,
          groupBy: 'year',
          prune: 'year'
        });
        
        expect(fsModule.rm).toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    test('skips pruning for invalid groupBy', async () => {
      generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
      generalModule.fileExists.mockResolvedValue(true);
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });
      
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'invalid',
        prune: 'invalid'
      });

      expect(vmSnapModule.logger.warn).toHaveBeenCalledWith(
        'Invalid groupBy: invalid.  Pruning disabled'
      );
      expect(fsModule.rm).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    test('skips pruning when previous backup folder does not exist', async () => {
      generalModule.parseArrayParam.mockResolvedValue(['test-domain']);
      generalModule.fileExists
        .mockResolvedValueOnce(true)   // Current folder exists
        .mockResolvedValueOnce(false); // Previous folder does not exist
      
      mockSpawnChild.on.mockImplementation((event, callback) => {
        if (event === 'close') {
          setTimeout(() => callback(0), 10);
        }
      });
      
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      await performBackup({
        domains: 'test-domain',
        output: '/backup',
        raw: false,
        groupBy: 'month',
        prune: 'month'
      });

      expect(fsModule.rm).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});