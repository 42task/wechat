#!/usr/bin/env python3
"""Freeze the pinned old-main source using adjacent local Git objects only.

Run from any directory: python3 scripts/legacy-differential/prepare-source.py
No checkout, fetch, application configuration, credentials, or services are used.
An existing snapshot must match; unknown or changed content is never removed.
"""
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import tarfile
import tempfile

COMMIT = 'c4e088adc7ba17bd5bb640ac31178a122906e002'
TREE = 'bfa30f98337bd8d5d392ed5b96cc854c06b60aad'
ROOT = pathlib.Path(__file__).resolve().parents[2]
REPOSITORY = ROOT.parent / 'game'
DESTINATION = ROOT / 'runtime/legacy-main-source-20261112'


def git(repository, *arguments, **kwargs):
    # Ignore inherited Git redirection and user/system configuration. These
    # commands read the specified local object database and never use remotes.
    environment = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    environment.update({'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
                        'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0'})
    return subprocess.run(['git', '--no-optional-locks', '-C', str(repository), *arguments],
                          env=environment, check=True, stderr=subprocess.PIPE, **kwargs)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def entries_from_git(repository):
    commit = git(repository, 'rev-parse', COMMIT + '^{commit}', stdout=subprocess.PIPE).stdout.decode().strip()
    tree = git(repository, 'rev-parse', COMMIT + '^{tree}', stdout=subprocess.PIPE).stdout.decode().strip()
    if commit != COMMIT or tree != TREE:
        raise RuntimeError('The adjacent repository does not contain the pinned old-main commit/tree')
    entries = []
    raw = git(repository, 'ls-tree', '-rz', '--full-tree', COMMIT, stdout=subprocess.PIPE).stdout
    for line in raw.split(b'\0'):
        if not line:
            continue
        head, raw_path = line.split(b'\t', 1)
        mode, kind, blob = head.decode().split(' ')
        path = raw_path.decode('utf-8')
        pure = pathlib.PurePosixPath(path)
        if kind != 'blob' or mode not in ('100644', '100755') or pure.is_absolute() or '..' in pure.parts:
            raise RuntimeError('Unsupported pinned Git member: ' + path)
        entries.append({'path': path, 'mode': mode, 'gitBlob': blob})
    return entries


def verify_archive(archive, expected):
    entries = {entry['path']: entry for entry in expected}
    directories = {parent.as_posix() for name in entries
                   for parent in pathlib.PurePosixPath(name).parents if parent.as_posix() != '.'}
    seen = set()
    verified = {}
    with tarfile.open(str(archive), mode='r:') as tar:
        for member in tar:
            pure = pathlib.PurePosixPath(member.name)
            if pure.is_absolute() or '..' in pure.parts or not (member.isfile() or member.isdir()):
                raise RuntimeError('Unsafe archive member: ' + member.name)
            if member.isdir():
                if pure.as_posix() not in directories:
                    raise RuntimeError('Unknown archive directory: ' + member.name)
                continue
            if member.name not in entries or member.name in seen:
                raise RuntimeError('Unknown or duplicate archive member: ' + member.name)
            expected_entry = entries[member.name]
            if bool(member.mode & 0o111) != (expected_entry['mode'] == '100755'):
                raise RuntimeError('Archive mode differs from pinned Git tree: ' + member.name)
            data = tar.extractfile(member).read()
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if blob != expected_entry['gitBlob']:
                raise RuntimeError('Archive bytes differ from pinned Git blob: ' + member.name)
            verified[member.name] = {**expected_entry, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
            seen.add(member.name)
    if seen != set(entries):
        raise RuntimeError('Archive is missing pinned Git files')
    return [verified[entry['path']] for entry in expected]


def verify_source(source, expected):
    if source.is_symlink() or not source.is_dir():
        raise RuntimeError('Source must be a real directory: ' + str(source))
    actual_files = set()
    actual_directories = set()
    for path in source.rglob('*'):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise RuntimeError('Unsupported source entry: ' + str(path))
        if path.is_file():
            actual_files.add(path.relative_to(source).as_posix())
        else:
            actual_directories.add(path.relative_to(source).as_posix())
    if actual_files != {entry['path'] for entry in expected}:
        raise RuntimeError('Existing source file inventory differs from the pinned Git tree')
    expected_directories = {parent.as_posix() for entry in expected
                            for parent in pathlib.PurePosixPath(entry['path']).parents if parent.as_posix() != '.'}
    if actual_directories != expected_directories:
        raise RuntimeError('Existing source directory inventory differs from the pinned Git tree')
    result = []
    for entry in expected:
        path = source / entry['path']
        data = path.read_bytes()
        blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if blob != entry['gitBlob']:
            raise RuntimeError('Existing source bytes differ from pinned Git blob: ' + entry['path'])
        if bool(path.stat().st_mode & 0o111) != (entry['mode'] == '100755'):
            raise RuntimeError('Existing source executable mode differs from pinned Git tree: ' + entry['path'])
        result.append({**entry, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    return result


def freeze(source):
    for path in source.rglob('*'):
        mode = 0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444
        if stat.S_IMODE(path.stat().st_mode) != mode:
            path.chmod(mode)
    if stat.S_IMODE(source.stat().st_mode) != 0o555:
        source.chmod(0o555)


def prepare(repository=REPOSITORY, destination=DESTINATION):
    repository = pathlib.Path(repository)
    destination = pathlib.Path(destination)
    if destination.is_symlink() or (destination.exists() and not destination.is_dir()):
        raise RuntimeError('Refusing an existing non-directory or symlink target')
    expected = entries_from_git(repository)
    archive = destination / 'source.tar'
    manifest_path = destination / 'manifest.json'
    source = destination / 'source'
    reused = destination.exists()
    if reused:
        if archive.is_symlink() or manifest_path.is_symlink() or not archive.is_file() or not manifest_path.is_file():
            raise RuntimeError('Refusing an unknown existing target without its archive and manifest')
        manifest = json.loads(manifest_path.read_text())
        if manifest.get('commit') != COMMIT or manifest.get('tree') != TREE or manifest.get('fileCount') != len(expected):
            raise RuntimeError('Existing snapshot provenance differs from the pinned Git tree')
        if digest(archive) != manifest.get('archiveSha256'):
            raise RuntimeError('Existing archive SHA256 differs from its manifest')
    else:
        destination.mkdir(parents=True)
        with archive.open('xb') as output:
            git(repository, 'archive', '--format=tar', COMMIT, stdout=output)
    # Verify every archived blob before extracting or trusting an existing copy.
    archived_files = verify_archive(archive, expected)
    current = {'commit': COMMIT, 'tree': TREE, 'archiveSha256': digest(archive),
               'archiveMethod': 'git archive --format=tar ' + COMMIT,
               'fileCount': len(archived_files), 'files': archived_files}
    if reused and manifest != current:
        raise RuntimeError('Existing manifest differs from pinned archive hashes; nothing was removed')
    extracted = False
    if not source.exists() and not source.is_symlink():
        staging = pathlib.Path(tempfile.mkdtemp(prefix='.source-stage-', dir=str(destination)))
        # Members were checked above; extract manually to avoid platform-specific
        # tar filters and to reject links/special files on every Python version.
        with tarfile.open(str(archive), mode='r:') as tar:
            for member in tar:
                path = staging / member.name
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open('xb') as output:
                        output.write(tar.extractfile(member).read())
                    path.chmod(0o755 if member.mode & 0o111 else 0o644)
        verify_source(staging, expected)
        staging.rename(source)
        extracted = True
    files = verify_source(source, expected)
    if files != archived_files:
        raise RuntimeError('Source SHA256 differs from the verified archive')
    if not reused:
        with manifest_path.open('x') as output:
            output.write(json.dumps(current, indent=2, ensure_ascii=False) + '\n')
    freeze(source)
    archive.chmod(0o444)
    manifest_path.chmod(0o444)
    return {'sourceCommit': COMMIT, 'tree': TREE, 'verifiedReadOnlyFiles': len(files),
            'archiveSha256': current['archiveSha256'], 'reused': reused, 'extracted': extracted,
            'source': str(source)}


if __name__ == '__main__':
    print(json.dumps(prepare(), ensure_ascii=False))
