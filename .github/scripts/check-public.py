#!/usr/bin/env python3
"""Check committed source, every ancestor, and the index without echoing private data."""
import argparse
import json
import pathlib
import re
import subprocess
import sys

OWNER = 'giovannirco@gmail.com'
EMAIL = re.compile(r'[\w.+:-]+@[\w.-]+\.[a-zA-Z]{2,}')
COAUTHOR = re.compile(r'^co-authored-by\s*:', re.I | re.M)
PRIVATE_PATH = re.compile(
    r'(^|/)(private|backups?|\.data|\.ai-memory|\.playwright-mcp|node_modules)(/|$)'
    r'|(^|/)(profile|resume|cv|transcript|bench-cases|values-prod|runtime|prod-runtime)([.-]|$)'
    r'|\.(dump|backup|sqlite3?|db|pem|key|p12|pfx|docx|pdf|png|jpe?g|zip|tar|gz)$'
    r'|(^|/)\.env(\.|$)', re.I)
SOURCE_SUFFIXES = {'.ts', '.tsx', '.py'}


def git(*args, data=None):
    return subprocess.check_output(['git', *args], input=data)


def path_errors(path):
    if re.search(r'(^|/)(private|backups?|\.data|\.ai-memory|\.playwright-mcp|node_modules)(/|$)', path, re.I):
        return ['private runtime directory']
    # These names describe application source, never runtime exports.
    if path == '.env.example' or (pathlib.PurePosixPath(path).suffix in SOURCE_SUFFIXES
                                 and path.startswith(('apps/', 'packages/', 'scripts/'))):
        return []
    return ['private export or binary artifact path'] if PRIVATE_PATH.search(path) else []


def content_errors(path, data):
    text = data.decode('utf-8', errors='replace')
    errors = []
    for address in EMAIL.findall(text):
        domain = address.rsplit('@', 1)[1].lower()
        synthetic = domain in {'example.com', 'example.org', 'example.net', 'example', 'test', 'invalid'} or domain.endswith(('.test', '.example', '.invalid'))
        chat = re.fullmatch(r'(?:false_)?(?:155555\d+(?::\d+)?|555555\d+|1111110\d+|120|999|x)@(?:c\.us|g\.us|s\.whatsapp\.net)', address)
        if address != OWNER and not synthetic and not chat:
            errors.append('non-synthetic contact address')
    if re.search(r'linkedin\.com/in/', text, re.I):
        errors.append('personal LinkedIn URL')
    if re.search(r'(?<!\d)55\d{10,11}(?!\d)', text):
        errors.append('Brazilian phone number')
    if re.search(r'ex[- ]employer|re[- ]hire watch', text, re.I):
        errors.append('personal employment annotation')
    if re.search(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', text):
        errors.append('private key')
    if path == 'packages/data/crypto-career-roots.json':
        try:
            catalog = json.loads(text)
            if any('why' in row or 'priority' in row for row in catalog.get('company_roots', [])):
                errors.append('personal career catalog annotations')
        except (ValueError, TypeError, AttributeError):
            errors.append('invalid career catalog')
    if path == 'scripts/bench-models.ts' and re.search(r'const\s+(?:TRIAGE_SET|HEAVY_POSITIONS)[^=\n]*=\s*\[', text):
        errors.append('embedded benchmark cases')
    return sorted(set(errors))


def commit_errors(raw):
    headers, _, message = raw.decode().partition('\n\n')
    errors = []
    for kind in ('author', 'committer'):
        match = re.search(r'^' + kind + r' .*<([^>]+)> ', headers, re.M)
        if not match or match[1] != OWNER:
            errors.append(kind + ' email must match the maintainer')
    if not re.search(r'^gpgsig ', headers, re.M):
        errors.append('missing commit signature')
    if COAUTHOR.search(message):
        errors.append('co-author trailer')
    errors += content_errors('<commit message>', message.encode())
    return errors


def batch_objects(oids):
    if not oids:
        return {}
    raw = git('cat-file', '--batch', data=('\n'.join(oids) + '\n').encode())
    result = {}
    offset = 0
    while offset < len(raw):
        end = raw.index(b'\n', offset)
        oid, kind, size = raw[offset:end].decode().split()
        offset = end + 1
        result[oid] = (kind, raw[offset:offset + int(size)])
        offset += int(size) + 1
    return result


def check(refs, index=False):
    failures = []
    configured = subprocess.run(['git', 'config', '--get', 'privacy.privatePatternsFile'], capture_output=True, text=True)
    private_patterns = []
    if configured.returncode == 0:
        pattern_file = pathlib.Path(configured.stdout.strip()).resolve()
        root = pathlib.Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve()
        if pattern_file == root or root in pattern_file.parents:
            raise ValueError('Private patterns must be stored outside the checkout')
        private_patterns = json.loads(pattern_file.read_text())
        if not isinstance(private_patterns, list) or any(not isinstance(value, str) or not value for value in private_patterns):
            raise ValueError('Private patterns must be a nonempty-string array')
    def inspect(path, data):
        errors = content_errors(path, data)
        if any(value.lower() in data.decode(errors='replace').lower() for value in private_patterns):
            errors.append('private-pattern match')
        return errors
    def report(label, errors):
        failures.extend(f'{label}: {error}' for error in errors)
    if index:
        entries = git('ls-files', '--stage', '-z').split(b'\0')
        blobs = []
        for entry in filter(None, entries):
            meta, name = entry.split(b'\t', 1)
            mode, oid, stage = meta.decode().split()
            path = name.decode()
            report(path, path_errors(path))
            if mode == '160000': report(path, ['submodule requires a separate privacy review'])
            else: blobs.append((path, oid))
        objects = batch_objects(list(dict.fromkeys(oid for _, oid in blobs)))
        for path, oid in blobs: report(path, inspect(path, objects[oid][1]))
    else:
        # Use hashes resolved with --end-of-options; user-provided refs are not Git flags.
        for ref in refs:
            oid = git('rev-parse', '--verify', '--end-of-options', ref).decode().strip()
            if git('cat-file', '-t', oid).strip() == b'tag':
                raw = git('cat-file', 'tag', oid)
                headers, _, message = raw.decode().partition('\n\n')
                report(oid[:12], inspect('<tag message>', message.encode()))
                if not re.search(r'^tagger .*<' + re.escape(OWNER) + r'> ', headers, re.M):
                    report(oid[:12], ['tagger email must match the maintainer'])
                if '-----BEGIN PGP SIGNATURE-----' not in message:
                    report(oid[:12], ['missing tag signature'])
        heads = [git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip() for ref in refs]
        oids = git('rev-list', '--objects', '--no-object-names', *heads).decode().splitlines()
        objects = batch_objects(oids)
        seen = set()
        def walk(oid, prefix=''):
            key = (oid, prefix)
            if key in seen: return
            seen.add(key)
            kind, data = objects[oid]
            if kind == 'blob':
                report(prefix, path_errors(prefix) + inspect(prefix, data))
                return
            offset = 0
            while offset < len(data):
                end = data.index(b'\0', offset)
                mode, name = data[offset:end].split(b' ', 1)
                child = data[end + 1:end + 21].hex()
                path = prefix + name.decode()
                if mode == b'160000': report(path, ['submodule requires a separate privacy review'])
                elif mode == b'40000': walk(child, path + '/')
                else: walk(child, path)
                offset = end + 21
        for oid, (kind, data) in objects.items():
            if kind == 'commit':
                report(oid[:12], commit_errors(data))
                report(oid[:12], inspect('<commit message>', data.split(b'\n\n', 1)[1]))
                walk(data.splitlines()[0].split()[1].decode())
    for failure in sorted(set(failures)):
        print(failure, file=sys.stderr)
    if failures:
        print('Public-source check failed. Keep real data outside this checkout.', file=sys.stderr)
        return 1
    print('Public-source check passed.')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', action='store_true')
    parser.add_argument('refs', nargs='*', default=['HEAD'])
    args = parser.parse_args()
    sys.exit(check(args.refs or ['HEAD'], args.index))
