# VMSnap

VMSnap is a tool designed to simplify the process of creating and managing
snapshots of KVM domains. This README provides an overview of the project,
installation instructions, usage guidelines, and contribution information.

## Features

- Query KVM domains for backup status
- Create snapshots of virtual machines
- Delete unnecessary bitmaps and checkpoints

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

| Switch  | Status | Backup | Scrub  |  Type   |                     Examples/Notes                       |
|---------|--------|--------|--------|---------|----------------------------------------------------------|
| domains | ✅     | ✅     | ✅     | string  | "vm1" or "vm1,vm2,etc" or "*"                            |
| status  | ✅     | -      | -      | boolean | Querys the domain(s)                                     |
| backup  | -      | ✅     | -      | boolean | Does an incremental backup (if possible)                 |
| scrub   | -      | -      | ✅     | boolean | Cleans checkpoints and bitmaps off of the domain         |
| output  | -      | ✅     | -      | string  | A full path to a directory where backups will be placed  |
| verbose | ✅     | -      | -      | boolean | Prints out extra information when running a status check |
| machine | ✅     | -      | -      | boolean | Removes some output from the status command              |
| json    | ✅     | -      | -      | boolean | Outputs the status command is JSON                       |
| yaml    | ✅     | -      | -      | boolean | Output YAML from the status command (aliased to `--yml`) |
| raw     | -      | ✅     | -      | boolean | Enables raw disk handling                                |
| prune   | -      | ✅     | -      | boolean | Rotates backups by **deleting** last months backup*      |

*\*This happens on or after the 15th of the current month*

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
info:    ▪ Getting statuses for domains: dom1
info:    ▪ Status for dom1:
info:    ▪   Checkpoints found for dom1:
info:    ▪     virtnbdbackup.0
info:    ▪     virtnbdbackup.1
info:    ▪   Eligible disks found for dom1:
info:    ▪     vda
info:    ▪       Virtual size: 107 GB
info:    ▪       Actual size: 14.3 GB
info:    ▪       Bitmaps found for vda:
info:    ▪           virtnbdbackup.0
info:    ▪           virtnbdbackup.1
```

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
    ]
  }
}
```

### Backup

Create a snapshot for `dom1` and output it to the `tmp` direcory:

```sh
vmsnap --domains="dom1" --output="/tmp" --backup
```

The above command will create a the backup for the domain. This creates a
checkpoint and dirty bitmap on the VM file and deposits the backup to the `/tmp`
directory

> **Tip:** Make sure you can read and write to the target directory in `--output`

#### Pruning (Caution)

**Note:** Pruning is destructive.  Be careful when using it and check your 
backups frequently!

Pruning backups may be done by setting `--prune="true"` on the backup command.
This flag will automatically delete last months backup once the 15th of the
current backup month comes up.

Turning on pruning means you will have a sliding window of backups between 2-6
weeks of time, depending on where you are in the backup cycle.

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
