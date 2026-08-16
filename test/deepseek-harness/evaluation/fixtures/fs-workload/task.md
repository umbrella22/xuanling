Complete the release preparation in this workspace using only the file tools available to you. Do not use shell tools, terminals, or subagents for any step.

1. Edit `src/config.json`: bump `version` to `1.5.0`, set `defaults.strictMode` to `true`, and set `features.legacyIndex` to `false`. Keep every other value and the overall JSON structure intact.
2. Edit `src/notes.md`: replace every occurrence of the exact phrase `ACL legacy flag` with `access-control flag`. Do not touch the hyphenated variant `ACL legacy-flag`; it must remain in the file exactly once.
3. Read `docs/glossary.md` and create a new file `RELEASE.md` at the workspace root containing:
   - a top-level heading `# Release 1.5.0`,
   - one section describing `Access control` and one describing `Retention window`, each using the term as written in the glossary,
   - a final line `Notes count: N` where `N` is the number of unchecked `- [ ]` items remaining in `src/notes.md` after your edit in step 2.
4. Read `src/deep/protocol.md`, confirm every path listed under `Manifest` exists in this workspace, then change `checksums-verified: no` to `checksums-verified: yes`.

Do not modify any other file. Do not create any other file.
