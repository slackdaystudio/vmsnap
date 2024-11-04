# VMSnap

VMSnap is a tool designed to simplify the process of creating and managing
snapshots of KVM domains. Backups generated by VMSnap are incremental, if 
possible.  VMSnap is also capable of performing a rudimentary backup rotation 
you may opt into.

This README provides an overview of the project, installation instructions, 
usage guidelines, and contribution information.

## Features

- Query KVM domains for backup status
- Create snapshots of virtual machines
- Delete unnecessary bitmaps and checkpoints

## Requirements

You must have the following on your host OS:
 - [virsh](https://libvirt.org/manpages/virsh.html)
 - [qemu-img](https://qemu-project.gitlab.io/qemu/tools/qemu-img.html)
 - [virtnbdbackup](https://github.com/abbbi/virtnbdbackup)

Getting these installed is out of scope for this doc.

Run the following command if you are not sure if you have them on your host OS.
 ```sh
which virsh && which qemu-img && which virtnbdbackup
 ```
You should see something like the following, assuming you have everything 
installed on your host.
```
/usr/bin/virsh
/usr/bin/qemu-img
/usr/bin/virtnbdbackup
```

## Installation

To install VMSnap, follow these steps:

```
npm install -g vmsnap
```

### Local

You may also choose to install VMSnap by checking the code out and running it
locally. To run localy, do the following:

1. Clone the repository:
   ```sh
   git clone git@github.com:slackdaystudio/vmsnap.git
   ```
2. Navigate to the project directory:
   ```sh
   cd vmsnap
   ```
3. Install the required dependencies:
   ```sh
   npm install
   ```

## Usage

This usage guide assumes you have installed VMSnap via the `npm install -g vmsnap`
command. Doing so will install VMSnap which includes a vmsnap bin.

> **Tip:** You may execute the same commands from a local checkout by swapping
> out the name of the bin for `npm run vmsnap --`. For example, to run a status
> check from a local version you first go to your code checkout and then run
> `npm run vmsnap -- --domains=vm1,vm2 --status`

## Command Line Switches

The following CLI switches are available when invoking VMSnap.

| Switch     | Status | Backup | Scrub  |  Type   |                     Examples/Notes                                |
|------------|--------|--------|--------|---------|-------------------------------------------------------------------|
| domains    | ✅     | ✅     | ✅     | string  | "vm1" or "vm1,vm2,etc" or "*"                                     |
| status     | ✅     | -      | -      | boolean | Querys the domain(s)                                              |
| backup     | -      | ✅     | -      | boolean | Does an incremental backup (if possible)                          |
| scrub      | -      | -      | ✅     | boolean | Cleans checkpoints and bitmaps off of the domain                  |
| output     | ✅     | ✅     | -      | string  | A full path to a directory where backups are placed               |
| verbose    | ✅     | -      | -      | boolean | Prints out extra information when running a status check          |
| machine    | ✅     | -      | -      | boolean | Removes some output from the status command                       |
| json       | ✅     | -      | -      | boolean | Outputs the status command is JSON                                |
| yaml       | ✅     | -      | -      | boolean | Output YAML from the status command (aliased to `--yml`)          |
| raw        | -      | ✅     | -      | boolean | Enables raw disk handling                                         |
| groupBy    | ✅     | ✅     | -      | string  | Defines how backups are grouped on disk (month, quarter, or year) | 
| prune      | -      | ✅     | -      | boolean | Rotates backups by **deleting** last periods backup*              |
| pretty     | ✅     | -      | -      | boolean | Pretty prints disk sizes (42.6 GB, 120 GB, etc)                   |

*\*This happens on or after the the middle of the current period (15 days monthly, 45 days quarterly or 180 yearly)*

### Status

The default action for VMSnap is to display a status report for VMs supplied.

```sh
vmsnap --domains="dom1" --status
```

> **Tip:** The `--domains` flag also accepts a comma seperated list of domains. 
> You may also pass in "\*" to select all found VMs. This is applicable to 
> backing up, scrubbing, or querying VMs.
>
> **Tip:** The `--status` flag may be omited.  Leaving it in is useful when 
> constructing backup and scrub commands because you may test the command by 
> querying the status of the domain.  If that query works you then swap the 
> `--status` flag for the `--backup` or `--scrub` flag, as appropriate.

This could return the following information if ran, as an example.

```
Status for dom1:
  Overall status: OK
  Checkpoints found for dom1:
    virtnbdbackup.0
    virtnbdbackup.1
    virtnbdbackup.2
  Eligible disks found for dom1:
    vda
      Virtual size: 107374182400
      Actual size: 14286573568
      Bitmaps found for vda:
          virtnbdbackup.0
          virtnbdbackup.1
          virtnbdbackup.2
```

>**Tip:** Pass in an `output=/PATH/TO/BACKUP_ROOT` flag to see statistics about 
> the backups already saved to disk.  VMSnap will perform additional integrity
> checks using the information it collects.

Machine parsable output is possible with the `--json` and `--yaml` flags in
combination with the `--machine` flag.

For example, running the following command...

```sh
vmsnap --domains="dom1" --machine --json
```

..will produce something like the following.

```json
{
  "dom1": {
    "checkpoints": ["virtnbdbackup.0", "virtnbdbackup.1"],
    "disks": [
      { "disk": "vda", "bitmaps": ["virtnbdbackup.0", "virtnbdbackup.1"] }
    ],
    "overallStatus": 0
  }
}
```

### Backup

Backups are always incremental unless VMSnap is cutting a new periods first 
backup.  Subsequent backups will be incremental meaning only the changes from
the VM will be captured.

Create a snapshot for `dom1` and output it to the `tmp` direcory:

```sh
vmsnap --domains="dom1" --output="/tmp" --backup
```

The above command will create a the backup for the domain. This creates a
checkpoint and dirty bitmap on the VM file and deposits the backup to the `/tmp`
directory. 

> **Tip:** Make sure you can read and write to the target directory in `--output`

You may also specify the `--groupBy` flag to tell VMSnap how to group your files
on disk. Look at the table below for more information.

| groupBy Flag | Middle Mark | Sample Folder Name              |
|--------------|-------------|---------------------------------|
| month        | 15d         | vmsnap-backup-monthly-2024-11   |
| quarter      | 45d         | vmsnap-backup-quarterly-2024-Q4 |
| year         | 180d        | vmsnap-backup-yearly-2024       | 

>**Tip:** If you **do not** set the `groupBy` flag the default period is assumed
> to be "month."

#### Pruning (Caution)

**Note:** Pruning is destructive.  Be careful when using it and check your 
backups frequently!

Pruning backups may be done by setting `--prune` on the backup command.
This flag will automatically delete last periods backup once the middle of the
current backup period comes up.

Pruning provides a sliding window for the given period of +/-50% depending upon
where you are in the backup cycle.  For example, setting the `groupBy` flag to
"month" would mean you would have 2-6 weeks of backups on hand at any given 
time.

#### Raw Disk Handling

You can turn on raw disk handling by setting the `--raw` flag.

### Scrubbing

**Note:** This is an inherently destructive action, be careful!

To scrub a VM of checkpoints and bitmaps:

```sh
vmsnap --domains="dom1" --scrub
```

## Contributing

We welcome contributions! Please follow these steps to contribute:

1. Fork the repository.
2. Create a new branch:
   ```sh
   git checkout -b feature-branch
   ```
3. Make your changes and commit them:
   ```sh
   git commit -m "Description of changes"
   ```
4. Push to the branch:
   ```sh
   git push origin feature-branch
   ```
5. Create a pull request.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file
for details.

## Contact

For any questions or feedback, please open an issue on GitHub.
