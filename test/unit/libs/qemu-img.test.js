import { describe, test, expect, vi, beforeEach } from 'vitest';
import { sep } from 'path';
import {
  QEMU_IMG,
  findBitmaps,
  cleanupBitmaps
} from '../../../libs/qemu-img.js';

// Mock external dependencies
vi.mock('../../../vmsnap.js', () => ({
  asyncExec: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('../../../libs/general.js', () => ({
  findKeyByValue: vi.fn()
}));

vi.mock('../../../libs/virsh.js', () => ({
  CHECKPOINT_REGEX: /^virtnbdbackup\.[0-9]*$/,
  fetchAllDisks: vi.fn()
}));

describe('qemu-img.js', () => {
  let vmSnapModule, generalModule, virshModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    vmSnapModule = await import('../../../vmsnap.js');
    generalModule = await import('../../../libs/general.js');
    virshModule = await import('../../../libs/virsh.js');
  });

  describe('constants', () => {
    test('exports correct QEMU_IMG constant', () => {
      expect(QEMU_IMG).toBe('qemu-img');
    });
  });

  describe('findBitmaps', () => {
    test('returns bitmap information for qcow2 disks', async () => {
      const mockDisks = new Map([
        ['vda', '/var/lib/libvirt/images/vm1.qcow2'],
        ['vdb', '/var/lib/libvirt/images/vm1-data.qcow2']
      ]);

      const mockQemuInfo1 = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'virtnbdbackup.123' },
              { name: 'virtnbdbackup.456' }
            ]
          }
        }
      };

      const mockQemuInfo2 = {
        'virtual-size': 21474836480,
        'actual-size': 10737418240,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'virtnbdbackup.789' }
            ]
          }
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue
        .mockReturnValueOnce('vda')
        .mockReturnValueOnce('vdb');

      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo1) })
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo2) });

      const result = await findBitmaps('test-domain');

      expect(result).toHaveLength(2);
      
      expect(result[0]).toEqual({
        disk: 'vda',
        virtualSize: 10737418240,
        actualSize: 5368709120,
        type: 'qcow2',
        name: 'vm1.qcow2',
        path: '/var/lib/libvirt/images/vm1.qcow2',
        bitmaps: [
          { name: 'virtnbdbackup.123' },
          { name: 'virtnbdbackup.456' }
        ]
      });

      expect(result[1]).toEqual({
        disk: 'vdb',
        virtualSize: 21474836480,
        actualSize: 10737418240,
        type: 'qcow2',
        name: 'vm1-data.qcow2',
        path: '/var/lib/libvirt/images/vm1-data.qcow2',
        bitmaps: [
          { name: 'virtnbdbackup.789' }
        ]
      });

      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'qemu-img info /var/lib/libvirt/images/vm1.qcow2 --output=json'
      );
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'qemu-img info /var/lib/libvirt/images/vm1-data.qcow2 --output=json'
      );
    });

    test('returns empty bitmaps array for raw disks', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.img']]);

      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 10737418240,
        'format': 'raw'
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      const result = await findBitmaps('test-domain');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('raw');
      expect(result[0].bitmaps).toEqual([]);
    });

    test('handles disks without format-specific data', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);

      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {} // No bitmaps key
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      const result = await findBitmaps('test-domain');

      expect(result).toHaveLength(1);
      expect(result[0].bitmaps).toEqual([]);
    });

    test('handles disks without format-specific section', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);

      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2'
        // No format-specific section - this will cause an error and skip the disk
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      const result = await findBitmaps('test-domain');

      // The disk gets skipped due to the error accessing format-specific.data.bitmaps
      expect(result).toHaveLength(0);
    });

    test('skips disks that fail qemu-img info command', async () => {
      const mockDisks = new Map([
        ['vda', '/var/lib/libvirt/images/vm1.qcow2'],
        ['vdb', '/var/lib/libvirt/images/corrupted.qcow2']
      ]);

      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': { 'data': { 'bitmaps': [] } }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo) })
        .mockRejectedValueOnce(new Error('Failed to read disk'));

      const result = await findBitmaps('test-domain');

      expect(result).toHaveLength(1);
      expect(result[0].disk).toBe('vda');
    });

    test('skips disks with invalid JSON output', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: 'invalid json' });

      const result = await findBitmaps('test-domain');

      expect(result).toHaveLength(0);
    });

    test('returns empty array when no disks found', async () => {
      virshModule.fetchAllDisks.mockResolvedValue(new Map());

      const result = await findBitmaps('test-domain');

      expect(result).toEqual([]);
    });

    test('handles complex directory paths correctly', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/subfolder/vm1.qcow2']]);

      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': { 'data': { 'bitmaps': [] } }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      const result = await findBitmaps('test-domain');

      expect(result[0].name).toBe('vm1.qcow2');
      expect(result[0].path).toBe('/var/lib/libvirt/images/subfolder/vm1.qcow2');
    });
  });

  describe('cleanupBitmaps', () => {
    test('removes all valid bitmaps when no specific name given', async () => {
      const mockBitmaps = [
        {
          disk: 'vda',
          path: '/var/lib/libvirt/images/vm1.qcow2',
          bitmaps: [
            { name: 'virtnbdbackup.123' },
            { name: 'virtnbdbackup.456' },
            { name: 'invalid-bitmap' }
          ]
        }
      ];

      // Mock findBitmaps
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);
      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'virtnbdbackup.123' },
              { name: 'virtnbdbackup.456' },
              { name: 'invalid-bitmap' }
            ]
          }
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo) })
        .mockResolvedValue({ stdout: '', stderr: '' }); // For bitmap removal commands

      await cleanupBitmaps('test-domain');

      // Should call qemu-img bitmap --remove for valid bitmaps only
      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(3); // 1 info + 2 bitmap removes
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'qemu-img bitmap --remove /var/lib/libvirt/images/vm1.qcow2 virtnbdbackup.123'
      );
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'qemu-img bitmap --remove /var/lib/libvirt/images/vm1.qcow2 virtnbdbackup.456'
      );
      
      expect(vmSnapModule.logger.info).toHaveBeenCalledTimes(2);
    });

    test('removes only specific bitmap when name provided', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);
      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'virtnbdbackup.123' },
              { name: 'virtnbdbackup.456' }
            ]
          }
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo) })
        .mockResolvedValue({ stdout: '', stderr: '' });

      await cleanupBitmaps('test-domain', 'virtnbdbackup.123');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(2); // 1 info + 1 remove
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'qemu-img bitmap --remove /var/lib/libvirt/images/vm1.qcow2 virtnbdbackup.123'
      );
      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'Removing bitmap virtnbdbackup.123 from /var/lib/libvirt/images/vm1.qcow2 on test-domain'
      );
    });

    test('skips disks with no bitmaps', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);
      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'raw'
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      await cleanupBitmaps('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(1); // Only info call
      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'No bitmaps found for vda on domain test-domain'
      );
    });

    test('skips bitmaps that do not match regex', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);
      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'invalid-bitmap-1' },
              { name: 'another-invalid' }
            ]
          }
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      await cleanupBitmaps('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(1); // Only info call
    });

    test('continues processing after bitmap removal failure', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);
      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'virtnbdbackup.123' },
              { name: 'virtnbdbackup.456' }
            ]
          }
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo) })
        .mockRejectedValueOnce(new Error('Failed to remove bitmap'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' });

      await cleanupBitmaps('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(3); // 1 info + 2 removes
      expect(vmSnapModule.logger.warn).toHaveBeenCalledWith(
        'Error removing bitmap virtnbdbackup.123 from /var/lib/libvirt/images/vm1.qcow2 on test-domain: Failed to remove bitmap'
      );
      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'Removing bitmap virtnbdbackup.456 from /var/lib/libvirt/images/vm1.qcow2 on test-domain'
      );
    });

    test('skips bitmaps that do not match specified name', async () => {
      const mockDisks = new Map([['vda', '/var/lib/libvirt/images/vm1.qcow2']]);
      const mockQemuInfo = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': {
          'data': {
            'bitmaps': [
              { name: 'virtnbdbackup.123' },
              { name: 'virtnbdbackup.456' }
            ]
          }
        }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue.mockReturnValue('vda');
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: JSON.stringify(mockQemuInfo) });

      await cleanupBitmaps('test-domain', 'virtnbdbackup.999');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(1); // Only info call
    });

    test('handles multiple disks correctly', async () => {
      const mockDisks = new Map([
        ['vda', '/var/lib/libvirt/images/vm1.qcow2'],
        ['vdb', '/var/lib/libvirt/images/vm1-data.qcow2']
      ]);

      const mockQemuInfo1 = {
        'virtual-size': 10737418240,
        'actual-size': 5368709120,
        'format': 'qcow2',
        'format-specific': { 'data': { 'bitmaps': [{ name: 'virtnbdbackup.123' }] } }
      };

      const mockQemuInfo2 = {
        'virtual-size': 21474836480,
        'actual-size': 10737418240,
        'format': 'qcow2',
        'format-specific': { 'data': { 'bitmaps': [{ name: 'virtnbdbackup.456' }] } }
      };

      virshModule.fetchAllDisks.mockResolvedValue(mockDisks);
      generalModule.findKeyByValue
        .mockReturnValueOnce('vda')
        .mockReturnValueOnce('vdb');
      
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo1) })
        .mockResolvedValueOnce({ stdout: JSON.stringify(mockQemuInfo2) })
        .mockResolvedValue({ stdout: '', stderr: '' });

      await cleanupBitmaps('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(4); // 2 info + 2 removes
    });
  });
});