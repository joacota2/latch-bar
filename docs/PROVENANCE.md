# Code and asset provenance

Reviewed on 2026-10-03 for the Apache 2.0 licensing PR.

## First-party material

Joaquin Gomez confirmed on 2026-10-03 that the original Latch Bar code, logo/app icons, and README images were all created by him. This records the maintainer's ownership confirmation; Git authorship or a checksum alone is not proof of copyright ownership. No separately owned first-party contributions or employer/client claims were identified in that confirmation.

| Material                                                                          | Evidence and scope                                                                                                                                                                |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application code, tests, configuration, and project documentation                 | Maintainer confirmation above. Existing author names `Joaquin Gomez` and `joacota2` are consistent with the maintainer's Git identity. Dependencies are treated separately below. |
| `public/latch-icon.svg`, `src-tauri/icons/latch.svg`, and generated icon variants | Maintainer confirmation; SVGs entered repository history in `b41594b`. The SVGs contain the project's geometric logo, without external image references.                          |
| `docs/media/latch-bar-hero.png`                                                   | Maintainer confirmation; introduction in `be528fa`, later wording update in `cfbbae9`.                                                                                            |
| `docs/media/latch-bar-studio.jpg` and `latch-bar-conversation.jpg`                | Maintainer confirmation; checked-in project UI imagery.                                                                                                                           |

`third-party/provenance.json` records hashes of the reviewed first-party assets. CI rejects added, removed, or changed assets until this record is reviewed and updated. For a new asset, record its creator/source and permission before updating the hash; regeneration of dependency notices does not approve asset ownership.

## Third-party material

- Production JavaScript packages come from the exact npm archives and integrity values in `package-lock.json`. This includes Lucide's icons and their upstream attribution, including Feather attribution in Lucide's license.
- Vite adds a module-preload polyfill to the built app. Vite, Rollup, esbuild, the React plugin, and Babel runtime/helpers are also included as a conservative set of build tools that can emit JavaScript into the distributed app. Their published licenses and bundled dependency notices are retained even though npm classifies them as development dependencies. Test-only tooling is excluded.
- Native dependencies are the union of the aarch64 and x86_64 macOS Cargo dependency graphs, including build dependencies and excluding dev-only edges. Archives are verified against `Cargo.lock`. Build dependencies are retained as a conservative attribution superset, including code generators.
- Original license, copyright, author, and notice files are collected recursively from those archives, including notices for vendored code. When a package omits these files, `third-party/supplements.json` records reviewed, version-specific replacements and their source URLs and hashes. Most are tied to the upstream revision recorded by the package. `sigchld` declares MIT but provides no standalone notice; the `objc2` workspace links to MIT rather than reproducing its text; `siphasher` preserves its copyright notice but omits the linked license texts. These exceptions include the canonical MIT template without inventing a copyright notice. MIT is selected for `siphasher` and where the `objc2` packages offer it as an option.
- The five MPL-2.0 crates have their complete, unmodified, checksum-verified crate source archives included in `third-party/sources/`. These retain MPL 2.0 and their original source notices. `THIRD_PARTY_NOTICES.txt` tells users where and how to obtain/extract them.
- DM Sans and Manrope variable font binaries are bundled under `public/fonts/`, from the exact Google Fonts revisions already recorded in the OFL supplements. Their binary URLs and SHA-256 hashes are recorded in `third-party/supplements.json` and separately in `third_party_assets_sha256` in the provenance inventory. They are third-party assets, not part of the maintainer ownership confirmation. Their OFL 1.1 notices remain included; CSS loads these unchanged binaries offline.
- macOS system frameworks and fonts are provided by the operating system, not copied into Latch Bar's distribution by this change.

This record covers the current macOS app and checked-in project assets. A Windows/Linux release, a new dependency license, copied source, or a new asset requires a fresh review. License metadata is not a substitute for reviewing the notices and any special obligations of newly added material.

## Upstream caveat

The [`objc2` upstream licensing explanation](https://github.com/madsmtm/objc2/blob/8852b424193ca41602281b3d7540d7c8ed51e49a/LICENSE.md) notes uncertainty about redistribution of bindings derived from Apple SDKs. Its authors still publish those crates under the stated open-source licenses and explain that building against the SDK requires Xcode and its agreement. That explanation is preserved in the shipped notices. This attribution review does not independently resolve the upstream SDK-permission question or establish ownership of upstream code; the maintainer's confirmation above covers Latch Bar's original material.
