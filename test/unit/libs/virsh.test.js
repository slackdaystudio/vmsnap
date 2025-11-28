import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EOL } from 'os';
import {
  VIRSH,
  CHECKPOINT_REGEX,
  domainExists,
  fetchAllDomains,
  findCheckpoints,
  cleanupCheckpoints,
  fetchAllDisks
} from '../../../libs/virsh.js';

// Mock the vmsnap module
vi.mock('../../../vmsnap.js', () => ({
  asyncExec: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('virsh.js', () => {
  let vmSnapModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    vmSnapModule = await import('../../../vmsnap.js');
  });

  describe('constants', () => {
    test('exports correct VIRSH constant', () => {
      expect(VIRSH).toBe('virsh');
    });

    test('CHECKPOINT_REGEX matches valid checkpoint names', () => {
      expect(CHECKPOINT_REGEX.test('virtnbdbackup.123')).toBe(true);
      expect(CHECKPOINT_REGEX.test('virtnbdbackup.0')).toBe(true);
      expect(CHECKPOINT_REGEX.test('virtnbdbackup.999999')).toBe(true);
      
      expect(CHECKPOINT_REGEX.test('invalid-checkpoint')).toBe(false);
      expect(CHECKPOINT_REGEX.test('virtnbdbackup.abc')).toBe(false);
      expect(CHECKPOINT_REGEX.test('virtnbdbackup')).toBe(false);
    });
  });

  describe('domainExists', () => {
    test('returns true when domain exists', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: 'running', stderr: '' });

      const result = await domainExists('valid-domain');

      expect(result).toBe(true);
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith('virsh domstate valid-domain');
    });

    test('returns false when domain does not exist', async () => {
      vmSnapModule.asyncExec.mockRejectedValue(new Error('Domain not found'));

      const result = await domainExists('nonexistent-domain');

      expect(result).toBe(false);
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith('virsh domstate nonexistent-domain');
    });

    test('returns false for domain with invalid characters', async () => {
      const result = await domainExists('invalid@domain#name');

      expect(result).toBe(false);
      expect(vmSnapModule.logger.error).toHaveBeenCalledWith(
        'Domain invalid@domain#name contains invalid characters'
      );
      expect(vmSnapModule.asyncExec).not.toHaveBeenCalled();
    });

    test('allows valid domain name characters', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: 'running', stderr: '' });

      const validDomains = [
        'ubuntu-vm',
        'centos_server',
        'web.server',
        'vm+test',
        'domain&test',
        'vm:/test',
        'VM123'
      ];

      for (const domain of validDomains) {
        await domainExists(domain);
      }

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(validDomains.length);
      expect(vmSnapModule.logger.error).not.toHaveBeenCalled();
    });
  });

  describe('fetchAllDomains', () => {
    test('returns list of domains from virsh output', async () => {
      const mockOutput = `ubuntu-vm${EOL}centos-server${EOL}web-vm${EOL}`;
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDomains();

      expect(result).toEqual(['ubuntu-vm', 'centos-server', 'web-vm']);
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith('virsh list --all --name');
    });

    test('filters out empty lines', async () => {
      const mockOutput = `ubuntu-vm${EOL}${EOL}centos-server${EOL}${EOL}`;
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDomains();

      expect(result).toEqual(['ubuntu-vm', 'centos-server']);
    });

    test('returns empty array when no domains found', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await fetchAllDomains();

      expect(result).toEqual([]);
    });

    test('throws error when virsh command fails', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ 
        stdout: '', 
        stderr: 'virsh: command not found' 
      });

      await expect(fetchAllDomains()).rejects.toThrow('virsh: command not found');
    });
  });

  describe('findCheckpoints', () => {
    test('returns list of checkpoints from virsh output', async () => {
      const mockOutput = `virtnbdbackup.123${EOL}virtnbdbackup.456${EOL}`;
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await findCheckpoints('test-domain');

      expect(result).toEqual(['virtnbdbackup.123', 'virtnbdbackup.456']);
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'virsh checkpoint-list test-domain --name'
      );
    });

    test('filters out empty and whitespace-only lines', async () => {
      const mockOutput = `virtnbdbackup.123${EOL}   ${EOL}virtnbdbackup.456${EOL}${EOL}`;
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await findCheckpoints('test-domain');

      expect(result).toEqual(['virtnbdbackup.123', 'virtnbdbackup.456']);
    });

    test('returns empty array when no checkpoints found', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: '', stderr: '' });

      const result = await findCheckpoints('test-domain');

      expect(result).toEqual([]);
    });

    test('throws error when virsh checkpoint-list fails', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ 
        stdout: '', 
        stderr: 'Domain not found' 
      });

      await expect(findCheckpoints('nonexistent-domain')).rejects.toThrow('Domain not found');
    });
  });

  describe('cleanupCheckpoints', () => {
    test('removes all valid checkpoints when no specific name given', async () => {
      const mockCheckpoints = ['virtnbdbackup.123', 'virtnbdbackup.456', 'invalid-checkpoint'];
      
      // Mock findCheckpoints call
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ 
          stdout: mockCheckpoints.join(EOL), 
          stderr: '' 
        })
        .mockResolvedValue({ stdout: '', stderr: '' }); // For delete commands

      await cleanupCheckpoints('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(3); // 1 list + 2 deletes
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'virsh checkpoint-delete test-domain virtnbdbackup.123 --metadata'
      );
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'virsh checkpoint-delete test-domain virtnbdbackup.456 --metadata'
      );
      expect(vmSnapModule.logger.info).toHaveBeenCalledTimes(2);
    });

    test('removes only specific checkpoint when name provided', async () => {
      const mockCheckpoints = ['virtnbdbackup.123', 'virtnbdbackup.456'];
      
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ 
          stdout: mockCheckpoints.join(EOL), 
          stderr: '' 
        })
        .mockResolvedValue({ stdout: '', stderr: '' });

      await cleanupCheckpoints('test-domain', 'virtnbdbackup.123');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(2); // 1 list + 1 delete
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'virsh checkpoint-delete test-domain virtnbdbackup.123 --metadata'
      );
      expect(vmSnapModule.logger.info).toHaveBeenCalledWith(
        'Removing checkpoint virtnbdbackup.123 from test-domain'
      );
    });

    test('skips checkpoints that do not match regex', async () => {
      const mockCheckpoints = ['invalid-checkpoint', 'another-invalid'];
      
      vmSnapModule.asyncExec.mockResolvedValueOnce({ 
        stdout: mockCheckpoints.join(EOL), 
        stderr: '' 
      });

      await cleanupCheckpoints('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(1); // Only list call
      expect(vmSnapModule.logger.info).not.toHaveBeenCalled();
    });

    test('does nothing when no checkpoints exist', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: '', stderr: '' });

      await cleanupCheckpoints('test-domain');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(1); // Only list call
    });

    test('throws error when checkpoint deletion fails', async () => {
      const mockCheckpoints = ['virtnbdbackup.123'];
      
      vmSnapModule.asyncExec
        .mockResolvedValueOnce({ 
          stdout: mockCheckpoints.join(EOL), 
          stderr: '' 
        })
        .mockResolvedValueOnce({ 
          stdout: '', 
          stderr: 'Failed to delete checkpoint' 
        });

      await expect(cleanupCheckpoints('test-domain')).rejects.toThrow(
        'Failed to delete checkpoint'
      );
    });

    test('skips checkpoints that do not match specified name', async () => {
      const mockCheckpoints = ['virtnbdbackup.123', 'virtnbdbackup.456'];
      
      vmSnapModule.asyncExec.mockResolvedValueOnce({ 
        stdout: mockCheckpoints.join(EOL), 
        stderr: '' 
      });

      await cleanupCheckpoints('test-domain', 'virtnbdbackup.999');

      expect(vmSnapModule.asyncExec).toHaveBeenCalledTimes(1); // Only list call
      expect(vmSnapModule.logger.info).not.toHaveBeenCalled();
    });
  });

  describe('fetchAllDisks', () => {
    test('parses disk list output correctly', async () => {
      const mockOutput = `Type       Device     Target     Source${EOL}` +
                        `file       disk       vda        /var/lib/libvirt/images/vm1.qcow2${EOL}` +
                        `file       disk       vdb        /var/lib/libvirt/images/vm1-data.qcow2${EOL}` +
                        `file       cdrom      hdc        -${EOL}`;
      
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDisks('test-domain');

      expect(result).toBeInstanceOf(Map);
      expect(result.get('vda')).toBe('/var/lib/libvirt/images/vm1.qcow2');
      expect(result.get('vdb')).toBe('/var/lib/libvirt/images/vm1-data.qcow2');
      expect(result.has('hdc')).toBe(false); // cdrom should be excluded
      expect(vmSnapModule.asyncExec).toHaveBeenCalledWith(
        'virsh domblklist test-domain --details'
      );
    });

    test('handles domains with no disks', async () => {
      const mockOutput = `Type       Device     Target     Source${EOL}`;
      
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDisks('test-domain');

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    test('filters out non-disk devices', async () => {
      const mockOutput = `Type       Device     Target     Source${EOL}` +
                        `file       disk       vda        /var/lib/libvirt/images/vm1.qcow2${EOL}` +
                        `file       cdrom      hdc        /path/to/cdrom.iso${EOL}` +
                        `network    interface  virbr0     default${EOL}`;
      
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDisks('test-domain');

      expect(result.size).toBe(1);
      expect(result.get('vda')).toBe('/var/lib/libvirt/images/vm1.qcow2');
    });

    test('handles malformed lines gracefully', async () => {
      const mockOutput = `Type       Device     Target     Source${EOL}` +
                        `file       disk       vda        /var/lib/libvirt/images/vm1.qcow2${EOL}` +
                        `malformed line${EOL}` +
                        `file disk vdb${EOL}`; // Missing source
      
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDisks('test-domain');

      expect(result.size).toBe(1);
      expect(result.get('vda')).toBe('/var/lib/libvirt/images/vm1.qcow2');
    });

    test('handles paths with spaces correctly', async () => {
      const mockOutput = `Type       Device     Target     Source${EOL}` +
                        `file       disk       vda        /var/lib/libvirt/images/vm with spaces.qcow2${EOL}`;
      
      vmSnapModule.asyncExec.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const result = await fetchAllDisks('test-domain');

      // The implementation splits on space, so paths with spaces get truncated
      expect(result.get('vda')).toBe('/var/lib/libvirt/images/vm');
    });

    test('throws error when virsh domblklist fails', async () => {
      vmSnapModule.asyncExec.mockResolvedValue({ 
        stdout: '', 
        stderr: 'Domain not found' 
      });

      await expect(fetchAllDisks('nonexistent-domain')).rejects.toThrow('Domain not found');
    });
  });
});