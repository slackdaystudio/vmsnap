#!/bin/bash
# create-test-vms.sh
# Script to create test VMs for VMSnap integration testing

set -e

# Configuration
TEST_DIR="${TEST_DIR:-/tmp/vmsnap-integration-test}"
VM_PREFIX="${VM_PREFIX:-vmsnap-test}"
TEMPLATE_DIR="$(dirname "$0")/../fixtures"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check for required commands
    for cmd in virsh qemu-img; do
        if ! command -v "$cmd" &> /dev/null; then
            log_error "$cmd is not installed"
            exit 1
        fi
    done

    # Check libvirt connection
    if ! virsh version &> /dev/null; then
        log_error "Cannot connect to libvirt. Make sure libvirtd is running."
        exit 1
    fi

    log_info "Prerequisites check passed"
}

# Create test directory
setup_test_dir() {
    log_info "Setting up test directory: $TEST_DIR"
    mkdir -p "$TEST_DIR"
}

# Create a test VM
create_test_vm() {
    local vm_name="$1"
    local disk_size="${2:-100M}"
    local ram_mb="${3:-128}"
    local vcpus="${4:-1}"

    local full_name="${VM_PREFIX}-${vm_name}"
    local disk_path="${TEST_DIR}/${full_name}.qcow2"
    local xml_path="${TEST_DIR}/${full_name}.xml"

    log_info "Creating VM: $full_name (disk: $disk_size, RAM: ${ram_mb}MB)"

    # Check if VM already exists
    if virsh dominfo "$full_name" &> /dev/null; then
        log_warn "VM $full_name already exists, skipping"
        return 0
    fi

    # Create disk image
    qemu-img create -f qcow2 "$disk_path" "$disk_size"

    # Generate XML from template
    if [ -f "$TEMPLATE_DIR/alpine-base.xml.template" ]; then
        sed -e "s|{VM_NAME}|$full_name|g" \
            -e "s|{DISK_PATH}|$disk_path|g" \
            -e "s|{RAM_MB}|$ram_mb|g" \
            -e "s|{VCPUS}|$vcpus|g" \
            "$TEMPLATE_DIR/alpine-base.xml.template" > "$xml_path"
    else
        # Generate XML inline if template not found
        cat > "$xml_path" <<EOF
<domain type='kvm'>
  <name>$full_name</name>
  <memory unit='MiB'>$ram_mb</memory>
  <vcpu>$vcpus</vcpu>
  <os>
    <type arch='x86_64'>hvm</type>
    <boot dev='hd'/>
  </os>
  <features>
    <acpi/>
    <apic/>
  </features>
  <cpu mode='host-passthrough'/>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2'/>
      <source file='$disk_path'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <interface type='user'>
      <model type='virtio'/>
    </interface>
    <serial type='pty'>
      <target port='0'/>
    </serial>
    <console type='pty'>
      <target type='serial' port='0'/>
    </console>
  </devices>
</domain>
EOF
    fi

    # Define the domain
    virsh define "$xml_path"

    log_info "VM $full_name created successfully"
}

# Main function
main() {
    check_prerequisites
    setup_test_dir

    # Create test VMs based on arguments or defaults
    if [ $# -eq 0 ]; then
        # Default set of test VMs
        create_test_vm "basic" "100M" "128" "1"
        create_test_vm "multi-1" "100M" "128" "1"
        create_test_vm "multi-2" "100M" "128" "1"
        create_test_vm "incremental" "150M" "128" "1"
        create_test_vm "rotation" "100M" "128" "1"
        create_test_vm "scrub" "100M" "128" "1"
    else
        # Create VMs from arguments
        for vm_name in "$@"; do
            create_test_vm "$vm_name"
        done
    fi

    log_info "Test VM creation complete"
    log_info "Created VMs:"
    virsh list --all --name | grep "^${VM_PREFIX}" || true
}

main "$@"
