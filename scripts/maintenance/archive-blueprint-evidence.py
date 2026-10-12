#!/usr/bin/env python3
"""Explicit, lossless evidence archives. No default source selection or deletion.

Inventory and manifests are JSON metadata; evidence bytes are never rewritten.
Archive publication uses an exclusive output lock and fsynced temporary rename.
Prune is separate and checkpoints a verified authorization before any unlink so
an interrupted run can resume without treating arbitrary missing files as success.
"""

import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tarfile
import tempfile


class Failure(Exception):
    def __init__(self, code, path=None, **metadata):
        self.audit = {"error": code, **metadata}
        if path is not None:
            self.audit["path"] = str(path)


def validate_relative_path(value, code="unsafe-path"):
    # Member identities are rejected, never normalized into a different identity.
    if not isinstance(value, str) or not value or "\x00" in value:
        raise Failure(code)
    if value.startswith("/") or any(p in ("", ".", "..") for p in value.split("/")):
        raise Failure(code, value)
    return value


def absolute_path(value):
    value = os.fspath(value)
    if not os.path.isabs(value):
        value = str(Path.cwd() / value)
    # macOS exposes its temporary directory through these fixed system aliases.
    # Resolve only those aliases; selected/user-created links still never follow.
    if sys.platform == "darwin":
        for alias, target in (("/var", "/private/var"), ("/tmp", "/private/tmp")):
            if value.startswith(alias + "/") and os.path.islink(alias) and os.path.realpath(alias) == target:
                value = target + value[len(alias):]
    validate_relative_path(value[1:])
    return Path(value)


@contextmanager
def open_directory(path, create=False):
    """Walk via directory descriptors, refusing symlink ancestors and escapes."""
    path = absolute_path(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                if error.errno in (20, 40):
                    raise Failure("external-follow", path) from None
                raise
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextmanager
def open_parent(root, relative):
    relative = validate_relative_path(relative)
    parent = Path(root) / PurePosixPath(relative).parent
    with open_directory(parent) as fd:
        yield fd, PurePosixPath(relative).name


@contextmanager
def open_regular(path):
    path = absolute_path(path)
    with open_directory(path.parent) as fd:
        try:
            leaf = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        except OSError as error:
            if error.errno == 40:
                raise Failure("external-follow", path) from None
            raise
        with os.fdopen(leaf, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise Failure("unsupported-type", path)
            yield stream


def digest(stream):
    h = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        h.update(chunk)
        size += len(chunk)
    return h.hexdigest(), size


def stat_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def entry_at(fd, name, relative):
    before = os.stat(name, dir_fd=fd, follow_symlinks=False)
    result = {"path": relative, "mode": stat.S_IMODE(before.st_mode), "mtime_ns": before.st_mtime_ns}
    if stat.S_ISREG(before.st_mode):
        leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(leaf, "rb") as stream:
            if stat_identity(os.fstat(stream.fileno())) != stat_identity(before):
                raise Failure("concurrent-change", relative)
            sha, size = digest(stream)
            if stat_identity(os.fstat(stream.fileno())) != stat_identity(before):
                raise Failure("concurrent-change", relative)
        result.update(type="file", size=size, sha256=sha)
    elif stat.S_ISLNK(before.st_mode):
        target = os.readlink(name, dir_fd=fd)
        data = os.fsencode(target)
        result.update(type="symlink", target=target, size=len(data), sha256=hashlib.sha256(data).hexdigest())
    elif stat.S_ISDIR(before.st_mode):
        result.update(type="directory", size=0, sha256=None)
    else:
        raise Failure("unsupported-type", relative)
    if stat_identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != stat_identity(before):
        raise Failure("concurrent-change", relative)
    return result, before


def entry(root, relative):
    with open_parent(root, relative) as (fd, name):
        return entry_at(fd, name, relative)[0]


def collect(root, selection, allow_missing=False):
    records = {}

    def visit(path):
        if path in records:
            return
        try:
            record = entry(root, path)
        except FileNotFoundError:
            if allow_missing:
                return
            raise Failure("missing-source", path) from None
        records[path] = record
        if record["type"] == "directory":
            with open_directory(Path(root) / path) as fd:
                names = sorted(os.listdir(fd))
            for name in names:
                visit(path + "/" + name)

    for selected in selection:
        visit(validate_relative_path(selected))
    return [records[path] for path in sorted(records)]


def read_json(path):
    try:
        with open_regular(path) as stream:
            return json.load(stream)
    except (ValueError, UnicodeError):
        raise Failure("invalid-manifest", path) from None


def encode_json(data):
    return (json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode("utf-8")


def path_exists(path):
    with open_directory(Path(path).parent) as fd:
        try:
            os.stat(Path(path).name, dir_fd=fd, follow_symlinks=False)
            return True
        except FileNotFoundError:
            return False


def publish_json(path, data, replace=False):
    path = absolute_path(path)
    with open_directory(path.parent, create=True) as fd:
        if not replace and path_exists(path):
            if read_json(path) != data:
                raise Failure("output-exists-different", path)
            return
        temp_fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(temp_fd, "wb") as stream:
                stream.write(encode_json(data))
                stream.flush()
                os.fsync(stream.fileno())
            os.rename(Path(temporary).name, path.name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)


def validate_inventory(data, code="invalid-manifest"):
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise Failure(code)
    selection = data.get("selection")
    members = data.get("members")
    if not isinstance(selection, list) or not selection or not isinstance(members, list) or not members:
        raise Failure(code)
    for selected in selection:
        validate_relative_path(selected, code)
    if len(set(selection)) != len(selection):
        raise Failure(code)
    seen = {}
    for member in members:
        if not isinstance(member, dict):
            raise Failure(code)
        path = validate_relative_path(member.get("path"), code)
        if path in seen or not any(path == s or path.startswith(s + "/") for s in selection):
            raise Failure(code, path)
        kind = member.get("type")
        if kind not in ("file", "symlink", "directory"):
            raise Failure(code, path)
        if not isinstance(member.get("size"), int) or member["size"] < 0:
            raise Failure(code, path)
        if not isinstance(member.get("mode"), int) or not 0 <= member["mode"] <= 0o7777:
            raise Failure(code, path)
        if not isinstance(member.get("mtime_ns"), int):
            raise Failure(code, path)
        if kind == "directory":
            if member["size"] != 0 or member.get("sha256") is not None:
                raise Failure(code, path)
        elif not isinstance(member.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", member["sha256"]):
            raise Failure(code, path)
        if kind == "symlink":
            if not isinstance(member.get("target"), str) or "\x00" in member["target"]:
                raise Failure(code, path)
            link = os.fsencode(member["target"])
            if len(link) != member["size"] or hashlib.sha256(link).hexdigest() != member["sha256"]:
                raise Failure(code, path)
        seen[path] = member
    for path in seen:
        for ancestor in PurePosixPath(path).parents:
            if str(ancestor) in seen and seen[str(ancestor)]["type"] != "directory":
                raise Failure(code, path)
    if any(s not in seen for s in selection):
        raise Failure(code)
    return seen


def receipt_path(archive):
    return Path(archive).with_suffix(".prune.json")


def manifest_path(archive):
    return Path(archive).with_suffix(".manifest.json")


def load_prune_receipt(path, manifest, root):
    if not path_exists(path):
        return None
    receipt = read_json(path)
    if (not isinstance(receipt, dict) or receipt.get("schema_version") != 1
            or receipt.get("kind") != "verified-prune-receipt"
            or receipt.get("status") not in ("pruning", "pruned")
            or receipt.get("source_root") != str(root)
            or receipt.get("archive_sha256") != manifest["archive_sha256"]
            or receipt.get("members_sha256") != hashlib.sha256(encode_json(manifest["members"])).hexdigest()
            or receipt.get("authorized_members") != [m["path"] for m in manifest["members"]]):
        raise Failure("invalid-prune-receipt", path)
    return receipt


def check_sources(root, inventory, receipt=None):
    expected = validate_inventory(inventory)
    current = {m["path"]: m for m in collect(root, inventory["selection"], allow_missing=True)}
    for path in current.keys() - expected.keys():
        raise Failure("unknown-member", path)
    for path, member in expected.items():
        if path not in current:
            if receipt and path in receipt["authorized_members"]:
                continue
            raise Failure("missing-source", path)
        actual = current[path]
        # Child deletion changes a directory's mtime; its identity is its path/type.
        keys = ("type",) if member["type"] == "directory" else ("type", "size", "sha256", "mode", "mtime_ns", "target")
        if any(actual.get(key) != member.get(key) for key in keys):
            raise Failure("concurrent-change", path, expected_sha256=member["sha256"], actual_sha256=actual["sha256"])


@contextmanager
def verified_archive(archive, manifest_file=None):
    archive = absolute_path(archive)
    try:
        manifest = read_json(manifest_file or manifest_path(archive))
    except FileNotFoundError:
        raise Failure("incomplete", archive) from None
    expected = validate_inventory(manifest, "unsafe-member")
    with open_regular(archive) as stream:
        before = stat_identity(os.fstat(stream.fileno()))
        actual_sha, size = digest(stream)
        if actual_sha != manifest.get("archive_sha256"):
            raise Failure("archive-hash-mismatch", archive, expected_sha256=manifest.get("archive_sha256"), actual_sha256=actual_sha)
        if size != manifest.get("archive_size"):
            raise Failure("archive-size-mismatch", archive)
        stream.seek(0)
        try:
            with tarfile.open(fileobj=stream, mode="r:gz") as tar:
                seen = set()
                for member in tar:
                    path = validate_relative_path(member.name, "unsafe-member")
                    if path in seen or path not in expected:
                        raise Failure("unsafe-member", path)
                    seen.add(path)
                    record = expected[path]
                    kind = "file" if member.isfile() else "symlink" if member.issym() else "directory" if member.isdir() else None
                    if kind is None:
                        raise Failure("unsafe-member", path)
                    if kind != record["type"] or member.mode != record["mode"]:
                        raise Failure("member-mismatch", path)
                    if kind == "file":
                        with tar.extractfile(member) as payload:
                            sha, length = digest(payload)
                        if sha != record["sha256"] or length != record["size"] or member.size != length:
                            raise Failure("member-mismatch", path, expected_sha256=record["sha256"], actual_sha256=sha)
                    elif kind == "symlink" and member.linkname != record["target"]:
                        raise Failure("member-mismatch", path)
                if seen != expected.keys():
                    raise Failure("member-mismatch", archive)
                if stat_identity(os.fstat(stream.fileno())) != before:
                    raise Failure("concurrent-change", archive)
                yield manifest, tar
        except (tarfile.TarError, EOFError, gzip.BadGzipFile):
            raise Failure("archive-invalid", archive) from None


@contextmanager
def output_lock(archive):
    with open_directory(archive.parent, create=True) as fd:
        name = archive.name + ".lock"
        try:
            lock = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        except FileExistsError:
            raise Failure("output-locked", archive) from None
        os.close(lock)
        try:
            yield fd
        finally:
            os.unlink(name, dir_fd=fd)
            os.fsync(fd)


def archive_inventory(root, inventory, category, name, out=None):
    validate_inventory(inventory)
    if inventory.get("source_root") != str(root):
        raise Failure("source-root-mismatch", root)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name):
        raise Failure("invalid-archive-name", name)
    archive = absolute_path(out or root / f"docs/validation/{category}/archives/{name}.tar.gz")
    if archive.name != name + ".tar.gz" or archive.parts[-5:-1] != ("docs", "validation", category, "archives"):
        raise Failure("invalid-archive-output", archive)
    if any(str(archive).startswith(str(root / s) + "/") or archive == root / s for s in inventory["selection"]):
        raise Failure("output-inside-selection", archive)
    with output_lock(archive) as output_fd:
        if path_exists(manifest_path(archive)):
            if not path_exists(archive):
                raise Failure("incomplete", archive)
            with verified_archive(archive) as (existing, _):
                if any(existing.get(k) != inventory.get(k) for k in ("source_root", "selection", "members")):
                    raise Failure("archive-exists-different", archive)
                receipt = load_prune_receipt(receipt_path(archive), existing, root)
                check_sources(root, inventory, receipt)
                return {"status": "replay-verified", "archive": str(archive), "archive_sha256": existing["archive_sha256"], "member_count": len(existing["members"])}
        check_sources(root, inventory)
        temp_fd, temporary = tempfile.mkstemp(prefix="." + archive.name + ".", suffix=".tmp", dir=archive.parent)
        try:
            with os.fdopen(temp_fd, "wb") as container:
                with gzip.GzipFile(filename="", mode="wb", fileobj=container, mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT, dereference=False) as tar:
                        for record in inventory["members"]:
                            info = tarfile.TarInfo(record["path"])
                            info.mode = record["mode"]
                            info.mtime = record["mtime_ns"] / 1_000_000_000
                            if record["type"] == "file":
                                info.size = record["size"]
                                with open_regular(root / record["path"]) as payload:
                                    tar.addfile(info, payload)
                            else:
                                info.type = tarfile.SYMTYPE if record["type"] == "symlink" else tarfile.DIRTYPE
                                info.linkname = record.get("target", "")
                                tar.addfile(info)
                container.flush()
                os.fsync(container.fileno())
            with open_regular(temporary) as stream:
                sha, size = digest(stream)
            manifest = {**inventory, "category": category, "archive_sha256": sha, "archive_size": size}
            check_sources(root, inventory)
            with verified_archive(temporary, _temporary_manifest(temporary, manifest)):
                pass
            if path_exists(archive):
                with open_regular(archive) as stream:
                    old_sha, _ = digest(stream)
                if old_sha != sha:
                    raise Failure("archive-exists-different", archive, expected_sha256=sha, actual_sha256=old_sha)
            else:
                os.rename(Path(temporary).name, archive.name, src_dir_fd=output_fd, dst_dir_fd=output_fd)
                os.fsync(output_fd)
            publish_json(manifest_path(archive), manifest)
            return {"status": "archived-verified", "archive": str(archive), "manifest": str(manifest_path(archive)), "archive_sha256": sha, "archive_size": size, "member_count": len(manifest["members"])}
        finally:
            for leftover in (Path(temporary), manifest_path(temporary)):
                if os.path.lexists(leftover):
                    os.unlink(leftover)


def _temporary_manifest(temporary, manifest):
    path = manifest_path(temporary)
    publish_json(path, manifest)
    return path


def prune(root, archive, receipt_file=None):
    with output_lock(archive):
        with verified_archive(archive) as (manifest, _):
            if manifest.get("source_root") != str(root):
                raise Failure("source-root-mismatch", root)
            path = absolute_path(receipt_file or receipt_path(archive))
            if (path in (archive, manifest_path(archive))
                    or any(path == root / s or str(path).startswith(str(root / s) + "/") for s in manifest["selection"])):
                raise Failure("receipt-inside-selection", path)
            receipt = load_prune_receipt(path, manifest, root)
            check_sources(root, manifest, receipt)
            receipt = {
                "schema_version": 1, "kind": "verified-prune-receipt", "status": "pruning",
                "source_root": str(root), "archive_sha256": manifest["archive_sha256"],
                "members_sha256": hashlib.sha256(encode_json(manifest["members"])).hexdigest(),
                "authorized_members": [m["path"] for m in manifest["members"]],
                "removed_members": receipt.get("removed_members", []) if receipt else [],
            }
            # Durable authorization is written ONLY after full archive/source verification.
            publish_json(path, receipt, replace=True)
            for record in sorted(manifest["members"], key=lambda m: (-m["path"].count("/"), m["path"])):
                relative = record["path"]
                try:
                    with open_parent(root, relative) as (fd, name):
                        actual, before = entry_at(fd, name, relative)
                        keys = ("type",) if record["type"] == "directory" else ("type", "size", "sha256", "mode", "mtime_ns", "target")
                        if any(actual.get(k) != record.get(k) for k in keys):
                            raise Failure("concurrent-change", relative, expected_sha256=record["sha256"], actual_sha256=actual["sha256"])
                        if stat_identity(os.stat(name, dir_fd=fd, follow_symlinks=False)) != stat_identity(before):
                            raise Failure("concurrent-change", relative)
                        if record["type"] == "directory":
                            try:
                                os.rmdir(name, dir_fd=fd)
                            except OSError as error:
                                if error.errno in (39, 66):
                                    raise Failure("unknown-member", relative) from None
                                raise
                        else:
                            # Never recursively remove anything; the no-follow parent pins the namespace.
                            os.unlink(name, dir_fd=fd)
                        os.fsync(fd)
                except FileNotFoundError:
                    continue  # Permitted only by the preflight's verified receipt.
                if relative not in receipt["removed_members"]:
                    receipt["removed_members"].append(relative)
            receipt["status"] = "pruned"
            publish_json(path, receipt, replace=True)
            return {"status": "pruned", "receipt": str(path), "archive_sha256": manifest["archive_sha256"], "member_count": len(manifest["members"])}


def link_stays_inside(path, target, records):
    """Resolve against archived metadata: link/.. can escape despite lexical checks."""
    if not target or target.startswith("/"):
        return False
    parts = list(PurePosixPath(path).parent.parts)
    pending = target.split("/")
    visited = {path}
    while pending:
        part = pending.pop(0)
        if part in ("", "."):
            continue
        if part == "..":
            if not parts:
                return False
            parts.pop()
        else:
            parts.append(part)
            candidate = "/".join(parts)
            record = records.get(candidate)
            if record and record["type"] == "symlink":
                if candidate in visited or not record["target"] or record["target"].startswith("/"):
                    return False
                visited.add(candidate)
                parts.pop()
                pending = record["target"].split("/") + pending
    return True


def extract(archive, target):
    target = absolute_path(target)
    with verified_archive(archive) as (manifest, tar):
        with open_directory(target) as target_fd:
            if os.listdir(target_fd):
                raise Failure("restore-target-not-empty", target)
            skipped = []
            records = {m["path"]: m for m in manifest["members"]}
            for record in manifest["members"]:
                destination = target / record["path"]
                with open_directory(destination.parent, create=True):
                    pass
                if record["type"] == "directory":
                    with open_directory(destination, create=True):
                        pass
                elif record["type"] == "symlink":
                    if link_stays_inside(record["path"], record["target"], records):
                        with open_directory(destination.parent) as fd:
                            os.symlink(record["target"], destination.name, dir_fd=fd)
                    else:
                        skipped.append({"path": record["path"], "target": record["target"], "sha256": record["sha256"], "reason": "external-or-unresolved-link"})
                else:
                    with open_directory(destination.parent) as fd:
                        output = os.open(destination.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, record["mode"] & 0o777, dir_fd=fd)
                        with os.fdopen(output, "wb") as stream, tar.extractfile(record["path"]) as payload:
                            shutil.copyfileobj(payload, stream)
                            stream.flush()
                            os.fsync(stream.fileno())
                            os.fchmod(stream.fileno(), record["mode"] & 0o777)
                        with open_regular(destination) as restored:
                            sha, size = digest(restored)
                        if sha != record["sha256"] or size != record["size"]:
                            raise Failure("member-mismatch", record["path"], expected_sha256=record["sha256"], actual_sha256=sha)
                        os.utime(destination.name, ns=(record["mtime_ns"], record["mtime_ns"]), dir_fd=fd, follow_symlinks=False)
            return {"status": "restored", "target": str(target), "archive_sha256": manifest["archive_sha256"], "member_count": len(manifest["members"]), "skipped_links": skipped}


def parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Sidecars: NAME.tar.manifest.json and NAME.tar.prune.json. --paths-file is a JSON array of root-relative paths.\n"
        "Create one inventory/archive per historical report category, host reports, debug, or explicit preimages; nothing is auto-selected.\n"
        "Archive --out must end in docs/validation/{category}/archives/{name}.tar.gz; --root may be a frozen snapshot.\n"
        "A crash can leave a .lock: inspect that no writer remains before removing ONLY that lock and retrying.\n"
        "Extract requires an existing EMPTY explicit target; external symlinks are returned as skipped metadata.\n"
        "macOS /var and /tmp system aliases are canonicalized; other symlink ancestors are refused.")
    operation = p.add_mutually_exclusive_group(required=True)
    for name, help_text in (("inventory", "Inventory explicit source selections without following symlinks"),
                            ("archive", "Build, atomically publish and verify an inventory archive"),
                            ("verify", "Independently verify container SHA and every member"),
                            ("prune", "Separately delete only verified unchanged listed original members"),
                            ("lookup", "Look up one exact original member path in a verified archive"),
                            ("extract", "Restore verified members into an existing empty target")):
        operation.add_argument("--" + name, action="store_true", help=help_text)
    p.add_argument("--root", default=str(Path.cwd()), help="Explicit checkout/snapshot root (default: cwd); no symlink ancestors")
    p.add_argument("--path", "--select", dest="paths", action="append", default=[], help="Root-relative selected file or directory; repeatable")
    p.add_argument("--paths-file", help="JSON array of explicit root-relative selections, combined with --select")
    p.add_argument("--output", "--out", dest="out", help="Inventory JSON output, or explicit classified .tar.gz archive output")
    p.add_argument("--inventory-file", help="Frozen inventory JSON input to --archive")
    p.add_argument("--category", choices=("blueprint", "host-integration", "debug"), help="Archive classification")
    p.add_argument("--name", help="Archive group name, e.g. runtime-contracts, host-reports, debug, preimages")
    p.add_argument("--archive-file", help="Existing .tar.gz to verify, prune, lookup or extract")
    p.add_argument("--receipt-file", help="Optional explicit prune receipt path (also use on prune replay)")
    p.add_argument("--member", help="Exact root-relative archive member to look up")
    p.add_argument("--target", help="Existing EMPTY extraction directory; never overwritten")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    root = absolute_path(args.root)
    if args.inventory or args.archive or args.prune:
        with open_directory(root):
            pass
    if args.inventory:
        selection = args.paths
        if args.paths_file:
            supplied = read_json(args.paths_file)
            if not isinstance(supplied, list):
                raise Failure("invalid-selection", args.paths_file)
            selection += supplied
        if not selection or not args.out:
            raise Failure("explicit-selection-and-output-required")
        selection = sorted(set(validate_relative_path(s) for s in selection))
        output = absolute_path(args.out)
        if any(output == root / s or str(output).startswith(str(root / s) + "/") for s in selection):
            raise Failure("output-inside-selection", output)
        data = {"schema_version": 1, "source_root": str(root), "selection": selection, "members": collect(root, selection)}
        publish_json(output, data)
        return {"status": "inventoried", "inventory": str(output), "member_count": len(data["members"]), "inventory_sha256": hashlib.sha256(encode_json(data)).hexdigest()}
    if args.archive:
        if not args.inventory_file or not args.category or not args.name:
            raise Failure("inventory-category-name-required")
        if args.paths or args.paths_file:
            raise Failure("selection-must-be-frozen-in-inventory")
        return archive_inventory(root, read_json(args.inventory_file), args.category, args.name, args.out)
    if not args.archive_file:
        raise Failure("archive-file-required")
    archive = absolute_path(args.archive_file)
    if args.prune:
        return prune(root, archive, args.receipt_file)
    if args.extract:
        if not args.target:
            raise Failure("empty-target-required")
        return extract(archive, args.target)
    with verified_archive(archive) as (manifest, _):
        if args.lookup:
            if not args.member:
                raise Failure("member-required")
            validate_relative_path(args.member, "unsafe-member")
            for member in manifest["members"]:
                if member["path"] == args.member:
                    return {"status": "found", "archive_sha256": manifest["archive_sha256"], "member": member}
            raise Failure("member-not-found", args.member)
        return {"status": "verified", "archive": str(archive), "archive_sha256": manifest["archive_sha256"], "archive_size": manifest["archive_size"], "member_count": len(manifest["members"])}


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=True, sort_keys=True))
    except Failure as error:
        print(json.dumps(error.audit, ensure_ascii=True, sort_keys=True), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, TypeError, KeyError) as error:
        # Never print exception text: it can embed historical raw evidence or keys.
        code = "invalid-manifest"
        if isinstance(error, OSError):
            code = "archive-write-failed" if "--archive" in sys.argv else "restore-write-failed" if "--extract" in sys.argv else "prune-failed" if "--prune" in sys.argv else "io-failed"
        audit = {"error": code, "errno": getattr(error, "errno", None)}
        if getattr(error, "filename", None) is not None:
            audit["path"] = str(error.filename)
        print(json.dumps(audit), file=sys.stderr)
        sys.exit(1)
