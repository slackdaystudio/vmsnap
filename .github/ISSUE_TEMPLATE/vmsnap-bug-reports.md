---
name: VMSnap Bug Reports
about: The default template for bug reports
title: ''
labels: ''
assignees: sentry0

---

Please supply your host OS library versions by running the following commands:
```
echo "NodeJS: $(node -v)" && echo "virsh: $(virsh -v)" && echo "qemu-img: $(qemu-img --version | grep -Eo '[0-9]*\.[0-9]*\.[0-9]*(-[a-zA-Z].*)?')" && echo "virtnbdbackup: $(virtnbdbackup --version)"
```
The output should look something like this;
```
NodeJS: v20.18.0
virsh: 8.0.0
qemu-img: 6.2.0
virtnbdbackup: 2.10
```
