# License scope and third-party notices

The root [MIT license](LICENSE) covers project-authored code, documentation and
synthetic demo content. It does not replace licenses for third-party material
listed below or for dependencies installed separately. Public names and marks
identify integrations and sources; they do not imply affiliation or endorsement.

## Linux CEC UAPI definitions: BSD-3-Clause

The native layouts and CEC constants in `src/server/native-cec.py` are translated
from [Linux v6.12 `include/uapi/linux/cec.h`](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/cec.h).
That header is copyright 2016 Cisco Systems, Inc. and/or its affiliates, and
offers `((GPL-2.0 WITH Linux-syscall-note) OR BSD-3-Clause)`.
This project uses the **BSD-3-Clause option for those definitions**, not MIT.
Their copyright, conditions and disclaimer are retained in the Python source
so the copied runtime helper also carries them. Preserve that notice in
redistributions. Project-authored transport logic remains MIT.

The upstream [BSD-3-Clause text](https://github.com/torvalds/linux/blob/v6.12/LICENSES/preferred/BSD-3-Clause)
defines the selected terms. `tests/native_cec_abi.c` includes the user's
installed Linux header for comparison; this repository does not bundle that
system header or the Linux kernel.

## Photographs: CC0 1.0 Universal

The 34 photographs by **Romain Guy**, their thumbnails, and photographic
portions of documentation screenshots/contact sheets remain **CC0 1.0**,
not MIT. Keep the [individual credits](docs/background-credits.md),
[per-photo evidence and hashes](docs/background-manifest.json), and catalog
attribution with this collection.

Sources and permissions are established per photograph, not by the MIT license
of an archive linking to them. CC0 does not grant trademark, publicity, privacy
or other rights that the person applying CC0 cannot waive. See
[CC0's legal terms](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en).
User-uploaded photos, MA artwork and provider lyrics are not bundled or licensed
by this project; use and share only material you are entitled to use.

## Dependencies and system packages

`package-lock.json` records exact dependency versions, public registry URLs,
integrity hashes and declared licenses. Dependencies retain their own
copyright notices and license files. They are downloaded during installation;
`node_modules`, compiled application bundles, native libraries, containers and
OS images are not part of this source-only distribution.

In particular, Sharp is **Apache-2.0**; optional prebuilt libvips packages are
**LGPL-3.0-or-later** and include components with additional licenses and
notices. The development dependency caniuse-lite uses **CC-BY-4.0**.
Inspect the exact installed packages' license/notice documents before
redistributing any build or appliance image. A future binary/container
distribution needs its own notice, source-availability and applicable
relinking compliance review; this project's MIT license is not sufficient.
JPEGs generated with Sharp do not inherit its native libraries' LGPL license.

Chromium, Python, libCEC/cec-utils, labwc, Node.js and other system packages
are installed separately under their respective licenses, not relicensed here.

The optional UCA222 source declares its separately downloaded Python dependencies
in `source/pyproject.toml`, including pinned `aiosendspin`, `sounddevice` and
`soundfile`. PortAudio, ALSA and libsndfile are installed separately as system
libraries; Python wheels may include native libraries with their own notices.
Retain and review the exact installed packages' licenses before redistributing
a source-service virtual environment or appliance image. Recordings are user
content, not bundled project assets; record and share only audio you are entitled
to use.

The package's `private: true` prevents accidental npm publication; it does not
require authentication to clone the public GitHub repository.
