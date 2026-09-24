#!/usr/bin/env python3
import importlib.util
import os
import pathlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('privacy', pathlib.Path(__file__).with_name('check-public.py'))
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PublicSourceTest(unittest.TestCase):
    def test_runtime_exports_and_binary_artifacts(self):
        for path in ['private/data.ts', '.data/state.json', 'backups/backup.sql', 'profile.json', 'resume.pdf', 'values-prod.yaml', '.env.local', 'nested/state.db']:
            self.assertTrue(privacy.path_errors(path), path)
        for path in ['.env.example', 'packages/core/src/profile.ts', 'packages/shared/src/profile-gate.test.ts', 'docs/DATA-MODEL.md']:
            self.assertFalse(privacy.path_errors(path), path)

    def test_synthetic_contacts_and_explicit_owner(self):
        for value in ['operator@example.com', 'ada@acme.test', privacy.OWNER, '15555550100:56@s.whatsapp.net', 'false_120@g.us']:
            self.assertFalse(privacy.content_errors('fixture.ts', value.encode()), value)
        # Construct deliberately rejected examples without publishing real contacts.
        for value in ['person@' + 'mail-provider.com', 'https://linkedin.com/' + 'in/fictional', '55' + '11999990000']:
            self.assertTrue(privacy.content_errors('fixture.ts', value.encode()))

    def test_career_annotations_and_embedded_cases(self):
        self.assertTrue(privacy.content_errors('packages/data/crypto-career-roots.json', b'{"company_roots":[{"why":"applied"}]}'))
        self.assertTrue(privacy.content_errors('scripts/bench-models.ts', b'const TRIAGE_SET = [];'))
        self.assertTrue(privacy.content_errors('note.md', ('ex-' + 'employer').encode()))
        self.assertFalse(privacy.content_errors('catalog.json', b'{"company":"Acme","url":"https://example.com/jobs"}'))

    def test_identity_and_trailers(self):
        header = f'author Owner <{privacy.OWNER}> 1 +0000\ncommitter Owner <{privacy.OWNER}> 1 +0000\ngpgsig placeholder\n\n'
        self.assertEqual(privacy.commit_errors((header + 'fix: example').encode()), [])
        self.assertIn('co-author trailer', privacy.commit_errors((header + 'Co-' + 'authored-by: Tool <tool@example.com>').encode()))
        self.assertTrue(privacy.commit_errors(header.replace(privacy.OWNER, 'other@example.com', 1).encode()))
        self.assertIn('missing commit signature', privacy.commit_errors(header.replace('gpgsig placeholder\n', '').encode()))

    def test_deleted_data_and_alternate_paths_remain_detectable(self):
        script = pathlib.Path(privacy.__file__).resolve()
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(['git', '-C', directory, *args], stderr=subprocess.DEVNULL)
            git('init', '-q')
            git('config', 'user.name', 'Fixture')
            git('config', 'user.email', privacy.OWNER)
            git('config', 'commit.gpgsign', 'false')
            git('config', 'core.hooksPath', '/dev/null')
            root = pathlib.Path(directory)
            (root / 'safe.txt').write_text('synthetic')
            (root / 'profile.json').write_text('synthetic')
            git('add', '.')
            git('commit', '-qm', 'fixture')
            git('rm', '-q', 'profile.json')
            git('commit', '-qm', 'remove fixture')
            result = subprocess.run(['python3', str(script), 'HEAD'], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('profile.json: private export', result.stderr)
            self.assertNotIn('synthetic', result.stderr)
            (root / 'profile.json').write_text('synthetic')
            git('add', '.')
            result = subprocess.run(['python3', str(script), '--index'], cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('profile.json: private export', result.stderr)
            with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as patterns:
                patterns.write('["synthetic"]')
                patterns.flush()
                git('config', 'privacy.privatePatternsFile', patterns.name)
                result = subprocess.run(['python3', str(script), '--index'], cwd=directory, capture_output=True, text=True)
                self.assertIn('private-pattern match', result.stderr)
                self.assertNotIn('synthetic', result.stderr)
                git('config', '--unset', 'privacy.privatePatternsFile')
            git('-c', 'tag.gpgsign=false', 'tag', '-a', 'unsigned-example', '-m', 'example')
            result = subprocess.run(['python3', str(script), 'unsigned-example'], cwd=directory, capture_output=True, text=True)
            self.assertIn('missing tag signature', result.stderr)


if __name__ == '__main__':
    unittest.main()
