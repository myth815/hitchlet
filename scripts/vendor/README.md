# Offline workspace discovery

Hitchlet’s Agent host can discover workspace members before project dependencies are installed. It uses the YAML parser and path matcher from TurboCli’s pnpm dependency tree. Upstream files and MIT licenses are preserved byte for byte. The js-yaml browser distribution has the local extension `.cjs` so Node can import it.

| npm release | Archive integrity (SHA-512, base64) |
| --- | --- |
| [js-yaml 4.3.2](https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.2.tgz) | `SFNOvSJ+Dgf/9An904Yx+CgSlIPCkIpao4qo51lpee25TIRejdH3rhR4EZMGoNx3/TP3O+wzWuiTFl4sqbltzA==` |
| [picomatch 4.0.7](https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz) | `qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==` |

Run `shasum -a 256 -c SHA256SUMS` inside this directory to verify the distributed files.
