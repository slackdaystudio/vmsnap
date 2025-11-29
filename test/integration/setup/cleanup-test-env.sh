#!/bin/bash
# cleanup-test-env.sh
# Script to clean up test VMs and files after integration testing

set -e

# Configuration
TEST_DIR="${TEST_DIR:-/tmp/vmsnap-integration-test}"
VM_PREFIX="${VM_PREFIX:-vmsnap-test}"

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

# Cleanup a single VM
cleanup_vm() {
    local vm_name="$1"

    log_info "Cleaning up VM: $vm_name"

    # Destroy if running
    if virsh domstate "$vm_name" 2>/dev/null | grep -q "running"; then
        log_info "  Destroying running VM..."
        virsh destroy "$vm_name" 2>/dev/null || true
    fi

    # Delete checkpoints
    local checkpoints
    checkpoints=$(virsh checkpoint-list "$vm_name" --name 2>/dev/null || true)
    if [ -n "$checkpoints" ]; then
        log_info "  Deleting checkpoints..."
        for checkpoint in $checkpoints; do
            virsh checkpoint-delete "$vm_name" "$checkpoint" 2>/dev/null || true
        done
    fi

    # Undefine the domain
    log_info "  Undefining domain..."
    virsh undefine "$vm_name" --checkpoints-metadata 2>/dev/null || \
        virsh undefine "$vm_name" 2>/dev/null || true

    log_info "  VM $vm_name cleaned up"
}

# Cleanup all test VMs
cleanup_all_vms() {
    log_info "Finding test VMs with prefix: $VM_PREFIX"

    local test_vms
    test_vms=$(virsh list --all --name 2>/dev/null | grep "^${VM_PREFIX}" || true)

    if [ -z "$test_vms" ]; then
        log_info "No test VMs found"
        return 0
    fi

    for vm_name in $test_vms; do
        cleanup_vm "$vm_name"
    done
}

# Cleanup test files
cleanup_files() {
    log_info "Cleaning up test files in: $TEST_DIR"

    if [ -d "$TEST_DIR" ]; then
        # Remove disk images
        find "$TEST_DIR" -name "*.qcow2" -delete 2>/dev/null || true
        # Remove XML files
        find "$TEST_DIR" -name "*.xml" -delete 2>/dev/null || true
        # Remove backup directories
        rm -rf "${TEST_DIR}/backups" 2>/dev/null || true

        log_info "Test files cleaned up"
    else
        log_info "Test directory does not exist, nothing to clean"
    fi
}

# Cleanup lock files
cleanup_locks() {
    log_info "Cleaning up lock files..."
    rm -f /tmp/vmsnap*.lock 2>/dev/null || true
}

# Remove test directory entirely
remove_test_dir() {
    if [ -d "$TEST_DIR" ]; then
        log_info "Removing test directory: $TEST_DIR"
        rm -rf "$TEST_DIR"
    fi
}

# Show usage
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --vms-only      Only cleanup VMs, keep files"
    echo "  --files-only    Only cleanup files, keep VMs"
    echo "  --full          Full cleanup including test directory"
    echo "  --vm NAME       Cleanup specific VM"
    echo "  -h, --help      Show this help message"
    echo ""
    echo "Environment variables:"
    echo "  TEST_DIR        Test directory (default: /tmp/vmsnap-integration-test)"
    echo "  VM_PREFIX       VM name prefix (default: vmsnap-test)"
}

# Main function
main() {
    local vms_only=false
    local files_only=false
    local full_cleanup=false
    local specific_vm=""

    while [[ $# -gt 0 ]]; do
        case $1 in
            --vms-only)
                vms_only=true
                shift
                ;;
            --files-only)
                files_only=true
                shift
                ;;
            --full)
                full_cleanup=true
                shift
                ;;
            --vm)
                specific_vm="$2"
                shift 2
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                exit 1
                ;;
        esac
    done

    log_info "Starting cleanup..."

    if [ -n "$specific_vm" ]; then
        cleanup_vm "$specific_vm"
    elif $vms_only; then
        cleanup_all_vms
    elif $files_only; then
        cleanup_files
        cleanup_locks
    else
        # Default: cleanup everything
        cleanup_all_vms
        cleanup_files
        cleanup_locks

        if $full_cleanup; then
            remove_test_dir
        fi
    fi

    log_info "Cleanup complete"
}

main "$@"
