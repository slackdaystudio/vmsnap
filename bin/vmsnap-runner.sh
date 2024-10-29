#!/usr/bin/env bash
# This script is used to run the vmsnap command via bash.  Both commands
# should be installed on the system. This script first loads the nvm environment
# variables and then runs the vmsnap command with the provided arguments.
#
# Author: Philip J. Guinchard <phil.guinchardard@slackdaystudio.ca>

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

VMSNAP=`which vmsnap`

if [ -z "${VMSNAP}" ]; then
    echo "vmsnap command not found.  Please install it."
    
    exit 1
fi

node ${VMSNAP} --domains="${1}" --output="${2}" --prune="$3:=false"
