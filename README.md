# VMSnap

VMSnap is a tool designed to simplify the process of creating and managing 
snapshots of virtual machines. This README provides an overview of the project, 
installation instructions, usage guidelines, and contribution information.

## Features

- Create snapshots of virtual machines
- Delete unnecessary bitmaps and checkpoints

## Installation

To install VMSnap, follow these steps:

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

To use VMSnap, issue the following commands from your checkout root:

### Status

The default action for VMSnap is to display a status report for VMs supplied.
```sh
npm run -s vmsnap -- --domains="dom1"
```

This could return the following information if ran, as an example.

```
info:    ▪ Status for dom1:
info:    ▪   Checkpoints found for dom1:
info:    ▪     virtnbdbackup.0
info:    ▪     virtnbdbackup.1
info:    ▪   Eligible disks found for dom1:
info:    ▪     vda
info:    ▪       Bitmaps found for vda:
info:    ▪           virtnbdbackup.0
info:    ▪           virtnbdbackup.1
```

Machine parsable output is possible with the `--json` and `--yaml` in 
combination with the `--machine` flag.

For example, running the following command... 
```sh
npm run -s vmsnap -- --domains="dom1" --machine --json
```
..will produce something like the following.
```json
{"dom1":{"checkpoints":["virtnbdbackup.0","virtnbdbackup.1"],"disks":[{"disk":"vda","bitmaps":["virtnbdbackup.0","virtnbdbackup.1"]}]}}
```

### Backup

Create a snapshot for `dom1` and output it to the `tmp` direcory:
```sh
npm run -s vmsnap -- --domains="dom1" --output="/tmp" --backup
```
The above command will create a the backup for the domain.  This creates a 
checkpoint and dirty bitmap on the VM file and deposits the backup to the `/tmp`
directory

#### Pruning

Pruning backups may be done by setting `--prune="true"` on the backup command.
This flag will automatically delete last months backup once the 15th of the 
current backup month comes up.  

Turning on pruning means you will have a sliding window of backups between 2-6
weeks of time, depending on where you are in the backup cycle.

#### Raw Disk Handling

You can turn on raw disk handling by setting `--raw`.  

#### Approving Disks

By default, the script will look for all virtual disks for bitmaps.  You may 
pass in a list of disks by setting `--approvedDisks="sda"`.

>Tip: The `--approvedDisks` flag also accepts a comma seperated list of disks.
You may also pass in "*" to backup all found disks.  This is applicable to 
backing up or scrubbing VMs.

### Scrubbing

To scrub a VM of checkpoints and bitmaps:
```sh
npm run vmsnap -- --domains="dom1" --scrub
```

>Tip: The `--domains` flag also accepts a comma seperated list of domains.  You 
may also pass in "*" to backup all found VMs.  This is applicable to backing up 
or scrubbing VMs.

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
