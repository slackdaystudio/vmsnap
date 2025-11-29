import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  checkDependencies,
  checkCommand,
  fileExists,
  findKeyByValue,
  parseArrayParam,
  scrubCheckpointsAndBitmaps
} from '../../../libs/general.js';

// Mock external dependencies
vi.mock('command-exists', () => ({
  default: vi.fn()
}));

vi.mock('fs/promises', () => ({
  access: vi.fn()
}));

// Mock virsh and qemu-img modules
vi.mock('../../../libs/virsh.js', () => ({
  fetchAllDomains: vi.fn(),
  cleanupCheckpoints: vi.fn(),
  VIRSH: 'virsh'
}));

vi.mock('../../../libs/qemu-img.js', () => ({
  cleanupBitmaps: vi.fn(),
  QEMU_IMG: 'qemu-img'
}));

vi.mock('../../../libs/libnbdbackup.js', () => ({
  BACKUP: 'virtnbdbackup'
}));

vi.mock('../../../vmsnap.js', () => ({
  ERR_DOMAINS: 1,
  ERR_INVALID_SCRUB_TYPE: 5,
  ERR_REQS: 4,
  ERR_SCRUB: 6,
  ERR_TOO_MANY_COMMANDS: 7,
  logger: {
    info: vi.fn(),
    error: vi.fn()
  }
}));

describe('general.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkDependencies', () => {
    test('passes when all dependencies exist', async () => {
      const commandExists = await import('command-exists');
      commandExists.default.mockResolvedValue(true);

      await expect(checkDependencies()).resolves.not.toThrow();
      expect(commandExists.default).toHaveBeenCalledTimes(3);
      expect(commandExists.default).toHaveBeenCalledWith('virsh');
      expect(commandExists.default).toHaveBeenCalledWith('qemu-img');
      expect(commandExists.default).toHaveBeenCalledWith('virtnbdbackup');
    });

    test('throws when dependencies are missing', async () => {
      const commandExists = await import('command-exists');
      commandExists.default
        .mockResolvedValueOnce(true)  // virsh exists
        .mockRejectedValueOnce(new Error('not found'))  // qemu-img missing
        .mockResolvedValueOnce(true);  // virtnbdbackup exists

      await expect(checkDependencies()).rejects.toThrow('Missing dependencies (qemu-img)');
    });

    test('throws when multiple dependencies are missing', async () => {
      const commandExists = await import('command-exists');
      commandExists.default
        .mockRejectedValueOnce(new Error('not found'))  // virsh missing
        .mockRejectedValueOnce(new Error('not found'))  // qemu-img missing
        .mockResolvedValueOnce(true);  // virtnbdbackup exists

      await expect(checkDependencies()).rejects.toThrow('Missing dependencies (virsh, qemu-img)');
    });
  });

  describe('checkCommand', () => {
    test('allows single command', () => {
      expect(() => checkCommand({ status: true, scrub: false, backup: false })).not.toThrow();
      expect(() => checkCommand({ status: false, scrub: true, backup: false })).not.toThrow();
      expect(() => checkCommand({ status: false, scrub: false, backup: true })).not.toThrow();
    });

    test('allows no commands', () => {
      expect(() => checkCommand({ status: false, scrub: false, backup: false })).not.toThrow();
    });

    test('throws when multiple commands specified', () => {
      expect(() => checkCommand({ status: true, scrub: true, backup: false }))
        .toThrow('Only one command can be run at a time');
      
      expect(() => checkCommand({ status: true, scrub: false, backup: true }))
        .toThrow('Only one command can be run at a time');
      
      expect(() => checkCommand({ status: false, scrub: true, backup: true }))
        .toThrow('Only one command can be run at a time');
      
      expect(() => checkCommand({ status: true, scrub: true, backup: true }))
        .toThrow('Only one command can be run at a time');
    });
  });

  describe('fileExists', () => {
    test('returns true when file exists', async () => {
      const fs = await import('fs/promises');
      fs.access.mockResolvedValue();

      const result = await fileExists('/some/path');
      
      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalledWith('/some/path');
    });

    test('returns false when file does not exist', async () => {
      const fs = await import('fs/promises');
      fs.access.mockRejectedValue(new Error('ENOENT'));

      const result = await fileExists('/nonexistent/path');
      
      expect(result).toBe(false);
      expect(fs.access).toHaveBeenCalledWith('/nonexistent/path');
    });
  });

  describe('findKeyByValue', () => {
    test('finds key for existing value', () => {
      const map = new Map([
        ['key1', 'value1'],
        ['key2', 'value2'],
        ['key3', 'value3']
      ]);

      expect(findKeyByValue(map, 'value2')).toBe('key2');
    });

    test('returns undefined for non-existing value', () => {
      const map = new Map([
        ['key1', 'value1'],
        ['key2', 'value2']
      ]);

      expect(findKeyByValue(map, 'nonexistent')).toBeUndefined();
    });

    test('works with empty map', () => {
      const map = new Map();
      expect(findKeyByValue(map, 'value')).toBeUndefined();
    });

    test('finds first matching key for duplicate values', () => {
      const map = new Map([
        ['key1', 'duplicate'],
        ['key2', 'duplicate'],
        ['key3', 'unique']
      ]);

      expect(findKeyByValue(map, 'duplicate')).toBe('key1');
    });
  });

  describe('parseArrayParam', () => {
    test('parses single domain', async () => {
      const result = await parseArrayParam('vm1');
      expect(result).toEqual(['vm1']);
    });

    test('parses comma-separated domains', async () => {
      const result = await parseArrayParam('vm1,vm2,vm3');
      expect(result).toEqual(['vm1', 'vm2', 'vm3']);
    });

    test('handles wildcard with fetchAll function', async () => {
      const mockFetchAll = vi.fn().mockResolvedValue(['vm1', 'vm2', 'vm3']);
      
      const result = await parseArrayParam('*', mockFetchAll);
      
      expect(result).toEqual(['vm1', 'vm2', 'vm3']);
      expect(mockFetchAll).toHaveBeenCalledOnce();
    });

    test('returns empty array for undefined param', async () => {
      const result = await parseArrayParam(undefined);
      expect(result).toEqual([]);
    });

    test('returns empty array for non-string param', async () => {
      const result = await parseArrayParam(123);
      expect(result).toEqual([]);
    });

    test('handles empty string', async () => {
      const result = await parseArrayParam('');
      expect(result).toEqual(['']); // Empty string is treated as a single domain
    });
  });

  describe('scrubCheckpointsAndBitmaps', () => {
    let virshModule, qemuImgModule, vmSnapModule;

    beforeEach(async () => {
      virshModule = await import('../../../libs/virsh.js');
      qemuImgModule = await import('../../../libs/qemu-img.js');
      vmSnapModule = await import('../../../vmsnap.js');
    });

    test('throws when no domains specified', async () => {
      await expect(scrubCheckpointsAndBitmaps({ domains: null }))
        .rejects.toThrow('No domains specified');
    });

    test('scrubs checkpoints only', async () => {
      virshModule.fetchAllDomains.mockResolvedValue(['vm1', 'vm2']);
      virshModule.cleanupCheckpoints.mockResolvedValue();

      const result = await scrubCheckpointsAndBitmaps({
        domains: 'vm1,vm2',
        scrubType: 'checkpoint',
        checkpointName: 'test-checkpoint'
      });

      expect(result).toBe(true);
      expect(virshModule.cleanupCheckpoints).toHaveBeenCalledTimes(2);
      expect(virshModule.cleanupCheckpoints).toHaveBeenCalledWith('vm1', 'test-checkpoint');
      expect(virshModule.cleanupCheckpoints).toHaveBeenCalledWith('vm2', 'test-checkpoint');
      expect(qemuImgModule.cleanupBitmaps).not.toHaveBeenCalled();
    });

    test('scrubs bitmaps only', async () => {
      virshModule.fetchAllDomains.mockResolvedValue(['vm1']);
      qemuImgModule.cleanupBitmaps.mockResolvedValue();

      const result = await scrubCheckpointsAndBitmaps({
        domains: 'vm1',
        scrubType: 'bitmap',
        checkpointName: 'test-checkpoint'
      });

      expect(result).toBe(true);
      expect(qemuImgModule.cleanupBitmaps).toHaveBeenCalledWith('vm1', 'test-checkpoint');
      expect(virshModule.cleanupCheckpoints).not.toHaveBeenCalled();
    });

    test('scrubs both checkpoints and bitmaps', async () => {
      virshModule.fetchAllDomains.mockResolvedValue(['vm1']);
      virshModule.cleanupCheckpoints.mockResolvedValue();
      qemuImgModule.cleanupBitmaps.mockResolvedValue();

      const result = await scrubCheckpointsAndBitmaps({
        domains: 'vm1',
        scrubType: 'both',
        checkpointName: 'test-checkpoint'
      });

      expect(result).toBe(true);
      expect(virshModule.cleanupCheckpoints).toHaveBeenCalledWith('vm1', 'test-checkpoint');
      expect(qemuImgModule.cleanupBitmaps).toHaveBeenCalledWith('vm1', 'test-checkpoint');
    });

    test('scrubs all with wildcard', async () => {
      virshModule.fetchAllDomains.mockResolvedValue(['vm1']);
      virshModule.cleanupCheckpoints.mockResolvedValue();
      qemuImgModule.cleanupBitmaps.mockResolvedValue();

      const result = await scrubCheckpointsAndBitmaps({
        domains: 'vm1',
        scrubType: '*'
      });

      expect(result).toBe(true);
      expect(virshModule.cleanupCheckpoints).toHaveBeenCalledWith('vm1');
      expect(qemuImgModule.cleanupBitmaps).toHaveBeenCalledWith('vm1');
    });

    test('throws error for invalid scrub type', async () => {
      virshModule.fetchAllDomains.mockResolvedValue(['vm1']);

      await expect(
        scrubCheckpointsAndBitmaps({
          domains: 'vm1',
          scrubType: 'invalid',
        })
      ).rejects.toThrow('Invalid scrub type: invalid');
    });

    test('throws error when cleanup fails', async () => {
      virshModule.fetchAllDomains.mockResolvedValue(['vm1']);
      virshModule.cleanupCheckpoints.mockRejectedValue(new Error('Cleanup failed'));

      await expect(
        scrubCheckpointsAndBitmaps({
          domains: 'vm1',
          scrubType: 'checkpoint',
        })
      ).rejects.toThrow('Cleanup failed');
    });
  });
});