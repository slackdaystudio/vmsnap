import { describe, test, expect, vi, beforeEach } from 'vitest';
import { getStatus } from '../../../libs/serialization.js';

// Mock external dependencies
vi.mock('fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn()
}));

vi.mock('../../../libs/general.js', () => ({
  fileExists: vi.fn(),
  parseArrayParam: vi.fn()
}));

vi.mock('../../../libs/qemu-img.js', () => ({
  findBitmaps: vi.fn()
}));

vi.mock('../../../libs/virsh.js', () => ({
  fetchAllDomains: vi.fn(),
  findCheckpoints: vi.fn()
}));

vi.mock('../../../libs/libnbdbackup.js', () => ({
  FREQUENCY_MONTHLY: 'month',
  getBackupFolder: vi.fn()
}));

describe('serialization.js', () => {
  let generalModule, qemuImgModule, virshModule, libnbdbackupModule, fsModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    generalModule = await import('../../../libs/general.js');
    qemuImgModule = await import('../../../libs/qemu-img.js');
    virshModule = await import('../../../libs/virsh.js');
    libnbdbackupModule = await import('../../../libs/libnbdbackup.js');
    fsModule = await import('fs/promises');
  });

  describe('getStatus', () => {
    test('returns basic status for single domain without backup path', async () => {
      const mockCheckpoints = ['checkpoint1', 'checkpoint2'];
      const mockBitmaps = [
        {
          disk: '/var/lib/libvirt/images/vm1.qcow2',
          virtualSize: 10737418240,
          actualSize: 5368709120,
          bitmaps: [
            { name: 'checkpoint1' },
            { name: 'checkpoint2' }
          ]
        }
      ];

      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(mockCheckpoints);
      qemuImgModule.findBitmaps.mockResolvedValue(mockBitmaps);

      const result = await getStatus('vm1');

      expect(result).toEqual({
        vm1: {
          checkpoints: ['checkpoint1', 'checkpoint2'],
          disks: [
            {
              disk: '/var/lib/libvirt/images/vm1.qcow2',
              virtualSize: 10737418240,
              actualSize: 5368709120,
              bitmaps: ['checkpoint1', 'checkpoint2']
            }
          ],
          overallStatus: 0 // STATUS_OK
        }
      });
    });

    test('returns pretty formatted disk sizes', async () => {
      const mockCheckpoints = ['checkpoint1'];
      const mockBitmaps = [
        {
          disk: '/var/lib/libvirt/images/vm1.qcow2',
          virtualSize: 1073741824, // 1GB
          actualSize: 536870912,   // 512MB
          bitmaps: [{ name: 'checkpoint1' }]
        }
      ];

      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(mockCheckpoints);
      qemuImgModule.findBitmaps.mockResolvedValue(mockBitmaps);

      const result = await getStatus('vm1', undefined, 'month', true);

      expect(result.vm1.disks[0].virtualSize).toBe('1.07 GB'); // pretty-bytes actual output
      expect(result.vm1.disks[0].actualSize).toBe('537 MB');
    });

    test('detects inconsistent status when checkpoints and bitmaps mismatch', async () => {
      const mockCheckpoints = ['checkpoint1', 'checkpoint2'];
      const mockBitmaps = [
        {
          disk: '/var/lib/libvirt/images/vm1.qcow2',
          virtualSize: 10737418240,
          actualSize: 5368709120,
          bitmaps: [{ name: 'checkpoint1' }] // Missing one bitmap
        }
      ];

      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(mockCheckpoints);
      qemuImgModule.findBitmaps.mockResolvedValue(mockBitmaps);

      const result = await getStatus('vm1');

      expect(result.vm1.overallStatus).toBe(1); // STATUS_INCONSISTENT
    });

    test('handles multiple domains', async () => {
      generalModule.parseArrayParam.mockResolvedValue(['vm1', 'vm2']);
      
      virshModule.findCheckpoints
        .mockResolvedValueOnce(['checkpoint1'])
        .mockResolvedValueOnce(['checkpoint2']);
      
      qemuImgModule.findBitmaps
        .mockResolvedValueOnce([
          {
            disk: '/var/lib/libvirt/images/vm1.qcow2',
            virtualSize: 10737418240,
            actualSize: 5368709120,
            bitmaps: [{ name: 'checkpoint1' }]
          }
        ])
        .mockResolvedValueOnce([
          {
            disk: '/var/lib/libvirt/images/vm2.qcow2',
            virtualSize: 21474836480,
            actualSize: 10737418240,
            bitmaps: [{ name: 'checkpoint2' }]
          }
        ]);

      const result = await getStatus('vm1,vm2');

      expect(Object.keys(result)).toEqual(['vm1', 'vm2']);
      expect(result.vm1.checkpoints).toEqual(['checkpoint1']);
      expect(result.vm2.checkpoints).toEqual(['checkpoint2']);
    });

    test('includes backup statistics when path provided', async () => {
      const mockCheckpoints = ['checkpoint1', 'checkpoint2'];
      const mockBitmaps = [
        {
          disk: '/var/lib/libvirt/images/vm1.qcow2',
          virtualSize: 10737418240,
          actualSize: 5368709120,
          bitmaps: [
            { name: 'checkpoint1' },
            { name: 'checkpoint2' }
          ]
        }
      ];

      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(mockCheckpoints);
      qemuImgModule.findBitmaps.mockResolvedValue(mockBitmaps);
      
      // Mock backup directory setup
      libnbdbackupModule.getBackupFolder.mockReturnValue('vmsnap-backup-monthly-2024-03');
      generalModule.fileExists.mockResolvedValue(true);
      
      // Mock directory contents
      fsModule.readdir.mockResolvedValueOnce(['checkpoint1.xml', 'checkpoint2.xml']);
      fsModule.stat
        .mockResolvedValueOnce({ size: 1024 })
        .mockResolvedValueOnce({ size: 2048 })
        .mockResolvedValueOnce({ size: 4096, isDirectory: () => false });

      // Mock collectDirStats behavior
      fsModule.readdir.mockResolvedValueOnce(['backup-file1', 'backup-file2']);
      fsModule.stat
        .mockResolvedValueOnce({ size: 1073741824, isDirectory: () => false })
        .mockResolvedValueOnce({ size: 2147483648, isDirectory: () => false });

      const result = await getStatus('vm1', '/backup/path', 'month');

      expect(result.vm1.backupDirStats).toBeDefined();
      expect(result.vm1.backupDirStats.path).toBe('/backup/path/vm1/vmsnap-backup-monthly-2024-03');
      expect(result.vm1.backupDirStats.checkpoints).toBe(2);
    });

    test('marks as inconsistent when backup checkpoint count differs', async () => {
      const mockCheckpoints = ['checkpoint1', 'checkpoint2'];
      const mockBitmaps = [
        {
          disk: '/var/lib/libvirt/images/vm1.qcow2',
          virtualSize: 10737418240,
          actualSize: 5368709120,
          bitmaps: [
            { name: 'checkpoint1' },
            { name: 'checkpoint2' }
          ]
        }
      ];

      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(mockCheckpoints);
      qemuImgModule.findBitmaps.mockResolvedValue(mockBitmaps);
      
      libnbdbackupModule.getBackupFolder.mockReturnValue('vmsnap-backup-monthly-2024-03');
      generalModule.fileExists.mockResolvedValue(true);
      
      // Only one checkpoint file in backup directory
      fsModule.readdir.mockResolvedValueOnce(['checkpoint1.xml']);
      fsModule.stat.mockResolvedValueOnce({ size: 1024 });
      
      fsModule.readdir.mockResolvedValueOnce([]);

      const result = await getStatus('vm1', '/backup/path', 'month');

      expect(result.vm1.overallStatus).toBe(1); // STATUS_INCONSISTENT
      expect(result.vm1.backupDirStats.checkpoints).toBe(1);
    });

    test('handles missing backup directories gracefully', async () => {
      const mockCheckpoints = ['checkpoint1'];
      const mockBitmaps = [
        {
          disk: '/var/lib/libvirt/images/vm1.qcow2',
          virtualSize: 10737418240,
          actualSize: 5368709120,
          bitmaps: [{ name: 'checkpoint1' }]
        }
      ];

      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(mockCheckpoints);
      qemuImgModule.findBitmaps.mockResolvedValue(mockBitmaps);
      
      libnbdbackupModule.getBackupFolder.mockReturnValue('vmsnap-backup-monthly-2024-03');
      generalModule.fileExists.mockResolvedValue(false); // Directory doesn't exist

      const result = await getStatus('vm1', '/backup/path', 'month');

      expect(result.vm1.backupDirStats).toEqual({
        path: '/backup/path/vm1/vmsnap-backup-monthly-2024-03',
        totalFiles: 0,
        checkpoints: 0,
        totalSize: 0
      });
    });

    test('handles empty domains list', async () => {
      generalModule.parseArrayParam.mockResolvedValue([]);

      const result = await getStatus('');

      expect(result).toEqual({});
    });

    test('handles domains with no disks', async () => {
      generalModule.parseArrayParam.mockResolvedValue(['vm1']);
      virshModule.findCheckpoints.mockResolvedValue(['checkpoint1']);
      qemuImgModule.findBitmaps.mockResolvedValue([]); // No disks

      const result = await getStatus('vm1');

      expect(result.vm1.disks).toEqual([]);
      expect(result.vm1.overallStatus).toBe(0); // STATUS_OK (no disks to compare)
    });
  });
});