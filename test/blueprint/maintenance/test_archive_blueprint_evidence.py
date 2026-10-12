"""Deletion/restore contracts; every CLI mutation uses a temporary fixture tree."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[3] / "scripts/maintenance/archive-blueprint-evidence.py"


class ArchiveContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "checkout"
        self.root.mkdir()
        self.source = self.root / "test/blueprint/reports/history"
        self.source.mkdir(parents=True)
        self.payload = b"failure evidence\x00\xff\r\nsecret-canary-do-not-print"
        (self.source / "receipt.bin").write_bytes(self.payload)
        (self.source / "empty").mkdir()
        (self.source / "unicode 空格.md").write_bytes(b"original\r\n")
        os.symlink("receipt.bin", self.source / "internal")
        self.external = Path(self.temp.name) / "external"
        self.external.write_bytes(b"external-must-not-be-followed")
        os.symlink(str(self.external), self.source / "external")
        self.inventory = self.root / "inventory.json"
        self.archive = self.root / "docs/validation/blueprint/archives/history.tar.gz"
        self.manifest = self.archive.with_suffix(".manifest.json")
        self.receipt = self.archive.with_suffix(".prune.json")

    def cli(self, *args, error=None):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--root", str(self.root), *map(str, args)],
            capture_output=True, text=True,
        )
        if error is None:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        failure = json.loads(result.stderr)
        self.assertEqual(failure["error"], error, result.stderr)
        self.assertNotIn("secret-canary-do-not-print", result.stderr)
        return failure

    def make_archive(self):
        self.cli("--inventory", "--path", "test/blueprint/reports/history", "--output", self.inventory)
        return self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history")

    def load_module(self):
        spec = importlib.util.spec_from_file_location("archive_helper", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_help_exposes_operations_and_explicit_selection(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in ("--inventory", "--archive", "--verify", "--prune", "--lookup", "--extract", "--paths-file", "--inventory-file", "--member", "--target"):
            self.assertIn(flag, result.stdout)

    def test_roundtrip_lookup_symlinks_and_verified_prune_replay(self):
        archived = self.make_archive()
        self.assertEqual(archived["archive_sha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        verified = self.cli("--verify", "--archive-file", self.archive)
        self.assertEqual(verified["status"], "verified")
        member = "test/blueprint/reports/history/receipt.bin"
        looked_up = self.cli("--lookup", "--archive-file", self.archive, "--member", member)
        self.assertEqual(looked_up["member"]["sha256"], hashlib.sha256(self.payload).hexdigest())
        target = self.root / "restore"
        target.mkdir()
        extracted = self.cli("--extract", "--archive-file", self.archive, "--target", target)
        self.assertEqual((target / member).read_bytes(), self.payload)
        self.assertEqual(os.readlink(target / "test/blueprint/reports/history/internal"), "receipt.bin")
        self.assertFalse((target / "test/blueprint/reports/history/external").is_symlink())
        self.assertEqual([x["path"] for x in extracted["skipped_links"]], ["test/blueprint/reports/history/external"])
        self.assertTrue((target / "test/blueprint/reports/history/empty").is_dir())
        self.cli("--prune", "--archive-file", self.archive)
        self.assertFalse(self.source.exists())
        self.cli("--prune", "--archive-file", self.archive)
        self.assertEqual(self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history")["status"], "replay-verified")
        self.assertEqual(self.external.read_bytes(), b"external-must-not-be-followed")

    def test_corrupt_container_refuses_verify_and_prune(self):
        self.make_archive()
        data = bytearray(self.archive.read_bytes())
        data[len(data) // 2] ^= 1
        self.archive.write_bytes(data)
        self.cli("--verify", "--archive-file", self.archive, error="archive-hash-mismatch")
        self.cli("--prune", "--archive-file", self.archive, error="archive-hash-mismatch")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)

    def test_member_corruption_even_with_updated_container_sha(self):
        self.make_archive()
        with tarfile.open(self.archive) as stream:
            members = [(m, stream.extractfile(m).read() if m.isfile() else None) for m in stream]
        with tarfile.open(self.archive, "w:gz") as stream:
            for entry, data in members:
                if entry.name.endswith("receipt.bin"):
                    data = b"X" * len(data)
                stream.addfile(entry, io.BytesIO(data) if data is not None else None)
        manifest = json.loads(self.manifest.read_text())
        manifest["archive_sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        manifest["archive_size"] = self.archive.stat().st_size
        self.manifest.write_text(json.dumps(manifest))
        self.cli("--verify", "--archive-file", self.archive, error="member-mismatch")

    def test_concurrent_edit_before_prune_preserves_every_member(self):
        self.make_archive()
        (self.source / "unicode 空格.md").write_bytes(b"changed")
        self.cli("--prune", "--archive-file", self.archive, error="concurrent-change")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)
        self.assertFalse(self.receipt.exists())

    def test_unknown_extra_before_prune_is_not_deleted(self):
        self.make_archive()
        extra = self.source / "new-user-file"
        extra.write_bytes(b"preserve")
        self.cli("--prune", "--archive-file", self.archive, error="unknown-member")
        self.assertEqual(extra.read_bytes(), b"preserve")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)

    def test_missing_without_verified_prune_receipt_refuses_replay(self):
        self.make_archive()
        (self.source / "receipt.bin").unlink()
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history", error="missing-source")
        self.cli("--prune", "--archive-file", self.archive, error="missing-source")

    def test_inventory_external_symlink_is_metadata_and_ancestor_follow_refused(self):
        self.make_archive()
        members = json.loads(self.inventory.read_text())["members"]
        link = next(m for m in members if m["path"].endswith("/external"))
        self.assertEqual(link["target"], str(self.external))
        self.assertEqual(link["sha256"], hashlib.sha256(os.fsencode(str(self.external))).hexdigest())
        self.cli("--inventory", "--path", "test/blueprint/reports/history/external/child", "--output", self.root / "bad.json", error="external-follow")
        self.cli("--inventory", "--path", "../external", "--output", self.root / "bad.json", error="unsafe-path")

    def test_changed_symlink_before_prune_and_swapped_ancestor_are_refused(self):
        self.make_archive()
        link = self.source / "external"
        link.unlink()
        link.symlink_to("receipt.bin")
        self.cli("--prune", "--archive-file", self.archive, error="concurrent-change")
        link.unlink()
        link.symlink_to(self.external)
        renamed = self.source.with_name("saved-history")
        self.source.rename(renamed)
        self.source.symlink_to(renamed, target_is_directory=True)
        self.cli("--prune", "--archive-file", self.archive, error="concurrent-change")
        self.assertEqual((renamed / "receipt.bin").read_bytes(), self.payload)

    def test_overwrite_and_nonempty_restore_refused(self):
        self.make_archive()
        before = self.archive.read_bytes()
        (self.source / "receipt.bin").write_bytes(b"new evidence")
        self.cli("--inventory", "--path", "test/blueprint/reports/history", "--output", self.root / "new.json")
        self.cli("--archive", "--inventory-file", self.root / "new.json", "--category", "blueprint", "--name", "history", error="archive-exists-different")
        self.assertEqual(self.archive.read_bytes(), before)
        target = self.root / "restore"
        target.mkdir()
        (target / "keep").write_bytes(b"keep")
        self.cli("--extract", "--archive-file", self.archive, "--target", target, error="restore-target-not-empty")
        self.assertEqual((target / "keep").read_bytes(), b"keep")

    def test_unsafe_archive_members_refused_before_extraction(self):
        self.make_archive()
        for unsafe in ("../escape", "/absolute", "a/../escape", "duplicate"):
            with self.subTest(unsafe=unsafe):
                with tarfile.open(self.archive, "w:gz") as stream:
                    info = tarfile.TarInfo(unsafe)
                    info.size = 1
                    stream.addfile(info, io.BytesIO(b"x"))
                    if unsafe == "duplicate":
                        stream.addfile(info, io.BytesIO(b"x"))
                manifest = json.loads(self.manifest.read_text())
                manifest["archive_sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
                manifest["archive_size"] = self.archive.stat().st_size
                manifest["members"] = [{"path": unsafe, "type": "file", "size": 1, "sha256": hashlib.sha256(b"x").hexdigest(), "mode": 420, "mtime_ns": 0}]
                manifest["selection"] = [unsafe]
                self.manifest.write_text(json.dumps(manifest))
                target = self.root / "empty-target"
                target.mkdir(exist_ok=True)
                self.cli("--extract", "--archive-file", self.archive, "--target", target, error="unsafe-member")
                self.assertEqual(list(target.iterdir()), [])

    def test_explicit_preimages_categories_and_paths_file(self):
        docs = self.root / "docs/plans/original.md"
        docs.parent.mkdir(parents=True)
        docs.write_bytes(self.payload)
        routes = self.root / "test/blueprint/capabilities/route.mjs"
        routes.parent.mkdir(parents=True)
        routes.write_bytes(b"old route\r\n")
        (self.root / "docs/validation/blueprint/current").mkdir(parents=True)
        (self.root / "docs/validation/blueprint/current/keep").write_bytes(b"current")
        paths = self.root / "paths.json"
        paths.write_text(json.dumps(["docs/plans/original.md", "test/blueprint/capabilities/route.mjs"]))
        self.cli("--inventory", "--paths-file", paths, "--output", self.inventory)
        result = self.cli("--archive", "--inventory-file", self.inventory, "--category", "debug", "--name", "preimages")
        self.assertEqual(result["member_count"], 2)
        archive = self.root / "docs/validation/debug/archives/preimages.tar.gz"
        with tarfile.open(archive) as stream:
            self.assertEqual(stream.getnames(), ["docs/plans/original.md", "test/blueprint/capabilities/route.mjs"])

    def test_incomplete_outputs_never_authorize_prune(self):
        self.make_archive()
        self.manifest.unlink()
        self.cli("--prune", "--archive-file", self.archive, error="incomplete")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)
        # A complete orphan container may be republished only after matching a new build.
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history")
        self.manifest.unlink()
        self.archive.write_bytes(b"interrupted partial gzip")
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history", error="archive-exists-different")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)

    def test_archive_write_interruption_keeps_sources_and_no_committed_outputs(self):
        self.cli("--inventory", "--path", "test/blueprint/reports/history", "--output", self.inventory)
        module = self.load_module()
        with mock.patch.object(module.tarfile.TarFile, "addfile", side_effect=OSError(28, "canary body must not be logged")):
            with self.assertRaises(OSError):
                module.main(["--root", str(self.root), "--archive", "--inventory-file", str(self.inventory), "--category", "blueprint", "--name", "history"])
        self.assertFalse(self.archive.exists())
        self.assertFalse(self.manifest.exists())
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history")

    def test_interrupted_prune_receipt_allows_exact_verified_resume(self):
        self.make_archive()
        module = self.load_module()
        original = module.os.unlink
        count = 0

        def interrupt(path, *args, **kwargs):
            nonlocal count
            if kwargs.get("dir_fd") is not None:
                count += 1
                if count == 2:
                    raise OSError(5, "interrupted")
            return original(path, *args, **kwargs)

        with mock.patch.object(module.os, "unlink", side_effect=interrupt):
            with self.assertRaises(OSError):
                module.main(["--root", str(self.root), "--prune", "--archive-file", str(self.archive)])
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt["status"], "pruning")
        self.cli("--prune", "--archive-file", self.archive)
        self.assertFalse(self.source.exists())

    def test_frozen_snapshot_out_and_independent_host_group(self):
        snapshot = self.root / "snapshot"
        (snapshot / "docs/plans").mkdir(parents=True)
        (snapshot / "docs/plans/original.md").write_bytes(self.payload)
        paths = self.root / "snapshot-paths.json"
        paths.write_text(json.dumps(["docs/plans/original.md"]))
        inventory = self.root / "preimages.json"
        self.cli("--root", snapshot, "--inventory", "--paths-file", paths, "--out", inventory)
        archive = self.root / "docs/validation/debug/archives/preimages.tar.gz"
        self.cli("--root", snapshot, "--archive", "--inventory-file", inventory,
                 "--category", "debug", "--name", "preimages", "--out", archive)
        target = self.root / "snapshot-restore"
        target.mkdir()
        self.cli("--extract", "--archive-file", archive, "--target", target)
        self.assertEqual((target / "docs/plans/original.md").read_bytes(), self.payload)
        self.assertEqual(list(target.iterdir()), [target / "docs"])
        host = self.root / "test/host-integration/reports"
        host.mkdir(parents=True)
        (host / "host.json").write_bytes(b'{"status":"failed"}\r\n')
        self.cli("--inventory", "--select", "test/host-integration/reports", "--out", self.root / "host.json")
        result = self.cli("--archive", "--inventory-file", self.root / "host.json", "--category", "host-integration", "--name", "host-reports")
        self.assertEqual(result["member_count"], 2)
        self.assertIn("host-integration/archives/host-reports.tar.gz", result["archive"])

    def test_edit_between_member_hash_and_unlink_is_detected(self):
        self.make_archive()
        module = self.load_module()
        original = module.entry_at
        calls = 0

        def change_after_hash(fd, name, relative):
            nonlocal calls
            result = original(fd, name, relative)
            if name == "receipt.bin":
                calls += 1
                if calls == 2:  # first call belongs to the complete source preflight
                    (self.source / name).write_bytes(b"concurrent writer")
            return result

        with mock.patch.object(module, "entry_at", side_effect=change_after_hash):
            with self.assertRaises(module.Failure) as failure:
                module.main(["--root", str(self.root), "--prune", "--archive-file", str(self.archive)])
        self.assertEqual(failure.exception.audit["error"], "concurrent-change")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), b"concurrent writer")

    def test_unverified_or_mismatched_prune_receipt_does_not_authorize_missing(self):
        self.make_archive()
        self.receipt.write_text(json.dumps({"status": "pruned", "authorized_members": ["test/blueprint/reports/history/receipt.bin"]}))
        (self.source / "receipt.bin").unlink()
        self.cli("--prune", "--archive-file", self.archive, error="invalid-prune-receipt")
        self.assertTrue((self.source / "unicode 空格.md").exists())

    def test_receipt_must_not_overwrite_a_source_or_archive(self):
        self.make_archive()
        for path in (self.source / "receipt.bin", self.archive, self.manifest):
            before = path.read_bytes()
            self.cli("--prune", "--archive-file", self.archive, "--receipt-file", path, error="receipt-inside-selection")
            self.assertEqual(path.read_bytes(), before)

    def test_output_symlink_ancestor_and_restore_symlink_target_refused(self):
        self.cli("--inventory", "--select", "test/blueprint/reports/history", "--out", self.inventory)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        (self.root / "docs").symlink_to(elsewhere, target_is_directory=True)
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history", error="external-follow")
        self.assertEqual(list(elsewhere.iterdir()), [])
        (self.root / "docs").unlink()
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history")
        target = self.root / "link-target"
        target.symlink_to(elsewhere, target_is_directory=True)
        self.cli("--extract", "--archive-file", self.archive, "--target", target, error="external-follow")
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_unsafe_hardlink_member_is_not_restored(self):
        self.make_archive()
        path = "test/blueprint/reports/history/receipt.bin"
        with tarfile.open(self.archive, "w:gz") as stream:
            info = tarfile.TarInfo(path)
            info.type = tarfile.LNKTYPE
            info.linkname = str(self.external)
            info.mode = 420
            stream.addfile(info)
        manifest = json.loads(self.manifest.read_text())
        manifest["selection"] = [path]
        manifest["members"] = [next(m for m in manifest["members"] if m["path"] == path)]
        manifest["archive_sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        manifest["archive_size"] = self.archive.stat().st_size
        self.manifest.write_text(json.dumps(manifest))
        target = self.root / "hardlink-target"
        target.mkdir()
        self.cli("--extract", "--archive-file", self.archive, "--target", target, error="unsafe-member")
        self.assertEqual(list(target.iterdir()), [])

    def test_link_target_tampering_is_detected_independently(self):
        self.make_archive()
        with tarfile.open(self.archive) as stream:
            members = [(m, stream.extractfile(m).read() if m.isfile() else None) for m in stream]
        with tarfile.open(self.archive, "w:gz") as stream:
            for info, data in members:
                if info.issym():
                    info.linkname = "changed-target"
                stream.addfile(info, io.BytesIO(data) if data is not None else None)
        manifest = json.loads(self.manifest.read_text())
        manifest["archive_sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        manifest["archive_size"] = self.archive.stat().st_size
        self.manifest.write_text(json.dumps(manifest))
        self.cli("--verify", "--archive-file", self.archive, error="member-mismatch")

    def test_interrupted_extract_is_partial_and_requires_new_empty_target(self):
        self.make_archive()
        module = self.load_module()
        target = self.root / "interrupted-restore"
        target.mkdir()
        with mock.patch.object(module.shutil, "copyfileobj", side_effect=OSError(28, "canary must not leak")):
            with self.assertRaises(OSError):
                module.main(["--extract", "--archive-file", str(self.archive), "--target", str(target)])
        self.cli("--extract", "--archive-file", self.archive, "--target", target, error="restore-target-not-empty")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)

    def test_output_lock_refuses_uncoordinated_replay(self):
        self.make_archive()
        lock = Path(str(self.archive) + ".lock")
        lock.write_bytes(b"interrupted writer")
        self.cli("--prune", "--archive-file", self.archive, error="output-locked")
        self.cli("--archive", "--inventory-file", self.inventory, "--category", "blueprint", "--name", "history", error="output-locked")
        self.assertEqual(lock.read_bytes(), b"interrupted writer")
        self.assertEqual((self.source / "receipt.bin").read_bytes(), self.payload)

    def test_missing_lookup_empty_selection_and_different_inventory_output(self):
        self.make_archive()
        self.cli("--lookup", "--archive-file", self.archive, "--member", "not-found", error="member-not-found")
        self.cli("--inventory", "--out", self.root / "empty.json", error="explicit-selection-and-output-required")
        before = self.inventory.read_bytes()
        self.cli("--inventory", "--select", "test/blueprint/reports/history/receipt.bin", "--out", self.inventory, error="output-exists-different")
        self.assertEqual(self.inventory.read_bytes(), before)

    def test_semantic_symlink_escape_and_external_chain_are_skipped(self):
        # Lexically shortcut/.. stays in history; the symlink makes it escape root.
        (self.source / "shortcut").symlink_to("../../../..", target_is_directory=True)
        (self.source / "semantic-escape").symlink_to("shortcut/..", target_is_directory=True)
        (self.source / "external-chain").symlink_to("external")
        self.make_archive()
        target = self.root / "semantic-restore"
        target.mkdir()
        result = self.cli("--extract", "--archive-file", self.archive, "--target", target)
        skipped = {m["path"].split("/")[-1] for m in result["skipped_links"]}
        self.assertEqual(skipped, {"external", "external-chain", "semantic-escape"})
        restored = target / "test/blueprint/reports/history"
        self.assertFalse((restored / "semantic-escape").is_symlink())
        self.assertFalse((restored / "external-chain").is_symlink())
        self.assertTrue((restored / "shortcut").is_symlink())


if __name__ == "__main__":
    unittest.main()
