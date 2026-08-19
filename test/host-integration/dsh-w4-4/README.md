# DSH W4.4 Dogfooding

This directory contains the maintainer-side runner and frozen task inputs for
the DSH half of the W4.4 host acceptance protocol. It is test evidence and is
not shipped in any runtime package.

The runner always uses a fresh absolute workspace, `DSH_HOME`, and Memory
database per trial. It launches the current DeepSeek Harness checkout through
its documented source-development entry point (`tsx apps/cli/src/bin.ts`) and
does not modify the DSH checkout.

Live runs require an explicit `--allow-billable-live` flag, a fresh
`XUANLING_DSH_RUN_ID`, and one owner-only credential-file reference. The
credential value is never read into the report.
