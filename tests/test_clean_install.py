"""Offline installation/protocol tests using an empty HOME and synthetic Vault only."""
import base64
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / 'scripts/native_host/install_host.py'


def frames(messages):
    output = b''
    for message in messages:
        raw = json.dumps(message).encode()
        output += struct.pack('@I', len(raw)) + raw
    return output


def decode(raw):
    output = []
    while raw:
        if len(raw) < 4:
            raise AssertionError('Truncated native protocol header')
        length = struct.unpack('@I', raw[:4])[0]
        body, raw = raw[4:4 + length], raw[4 + length:]
        assert len(body) == length
        output.append(json.loads(body))
    return output


class CleanInstallTests(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix='ob-clean-')
        self.addCleanup(self.sandbox.cleanup)
        self.base = Path(self.sandbox.name).resolve()
        self.home = self.base / "乾淨 ' user"
        self.vault = self.home / 'Clean Vault 空白'
        self.vault.mkdir(parents=True)
        self.config = self.home / 'Application Support/OB-Zotero'
        self.hosts = self.home / 'Chrome/NativeMessagingHosts'
        self.env = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}
        self.args = [sys.executable, '-I', str(INSTALLER), '--vault', str(self.vault),
                     '--vault-name', 'Clean & 測試 Vault', '--config-dir', str(self.config),
                     '--hosts-dir', str(self.hosts)]
        result = subprocess.run(self.args, env=self.env, capture_output=True, text=True, timeout=20, check=True)
        self.installed = json.loads(result.stdout)
        self.launcher = self.installed['launcher']

    def exchange(self, *messages):
        result = subprocess.run([self.launcher], input=frames(messages), env=self.env,
                                capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        replies = decode(result.stdout)
        self.assertEqual(len(replies), len(messages))
        return replies

    def test_launcher_has_no_dependency_on_shell_path_or_original_settings(self):
        manifest = json.loads(Path(self.installed['manifest']).read_text())
        self.assertEqual(manifest['path'], self.launcher)
        self.assertRegex(self.installed['extension_id'], '^[a-p]{32}$')
        reply, = self.exchange({'action': 'ping', 'payload': {}})
        self.assertEqual(reply['status'], 'ok')
        self.assertEqual(reply['vault_path'], str(self.vault))
        self.assertEqual(reply['zotero_indexed_dois'], 0)
        self.assertEqual(reply['zotero_mode'], 'offline')
        self.assertFalse(reply['gemini']['available'])
        self.assertTrue((self.config / 'cache/native_host.log').is_file())

    def test_empty_vault_status(self):
        reply, = self.exchange({'action': 'check_status', 'payload': {'topic': 'Neurology'}})
        self.assertEqual(reply['status'], 'ok')
        self.assertFalse(reply['zotero']['has_item'])
        self.assertFalse(reply['obsidian']['has_note'])
        self.assertFalse(reply['pdf']['has_pdf'])

    def test_ingest_source_and_update_note_preserves_frontmatter(self):
        reply, = self.exchange({'action': 'ingest_webpage', 'payload': {
            'metadata': {'title': 'Clean install example', 'authors': 'Tester A.', 'year': 2026,
                         'url': 'https://example.org/paper'},
            'sections': [{'heading': 'Results', 'level': 2, 'text': 'Synthetic offline content.'}],
            'figures': [], 'tables': [],
            'options': {'topic': 'Neurology', 'save_source': True, 'save_note': True,
                        'download_pdf': False, 'download_figures': False, 'save_zotero': False},
        }})
        self.assertEqual(reply['status'], 'success', reply)
        source = self.vault / reply['source']['path']
        note = self.vault / reply['note']['path']
        self.assertIn('Synthetic offline content.', source.read_text())
        original_fm = note.read_text().split('---', 2)[1]
        updated, = self.exchange({'action': 'save_reading_note', 'payload': {
            'topic': 'Neurology', 'stem': note.stem, 'target_type': 'note',
            'content': '<h2>Finding</h2><p>Clean environment works.</p>', 'is_html': True,
        }})
        self.assertEqual(updated['status'], 'success', updated)
        self.assertEqual(note.read_text().split('---', 2)[1], original_fm)
        self.assertIn('## Finding', note.read_text())
        self.assertEqual(parse_qs(urlparse(updated['obsidian_uri']).query)['vault'], ['Clean & 測試 Vault'])
        self.assertTrue((self.config / 'ingest_state.json').is_file())

    def test_chunked_pdf_and_inspection_cache(self):
        from pypdf import PdfWriter
        pdf = PdfWriter()
        pdf.add_blank_page(width=600, height=800)
        pdf.add_metadata({'/Title': 'Synthetic test ' * 150})
        buffer = io.BytesIO()
        pdf.write(buffer)
        content = buffer.getvalue()
        self.assertGreater(len(content), 1024)
        encoded = base64.b64encode(content).decode()
        middle = len(encoded) // 2
        common = {'transfer_id': 'clean-test', 'total_chunks': 2,
                  'topic': 'Neurology', 'stem': 'synthetic'}
        first, last = self.exchange(*[
            {'action': 'upload_pdf_chunk', 'payload': dict(common, chunk_index=i, chunk_base64=chunk)}
            for i, chunk in enumerate([encoded[:middle], encoded[middle:]])
        ])
        self.assertFalse(first['completed'])
        self.assertEqual(last['status'], 'success', last)
        self.assertEqual((self.vault / last['path']).read_bytes(), content)
        inspected, = self.exchange({'action': 'upload_pdf_chunk', 'payload': dict(
            common, transfer_id='inspection', chunk_index=0, total_chunks=1,
            chunk_base64=encoded, inspection=True)})
        self.assertEqual(inspected['status'], 'success', inspected)
        self.assertEqual(Path(inspected['path']).read_bytes(), content)
        self.assertTrue(Path(inspected['path']).is_relative_to(self.config))

    def test_existing_host_is_not_overwritten(self):
        path = Path(self.installed['manifest'])
        old = json.loads(path.read_text())
        old['path'] = '/existing/OB/native_host.py'
        path.write_text(json.dumps(old))
        before = path.read_bytes()
        result = subprocess.run(self.args, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--replace-host', result.stderr)
        self.assertEqual(path.read_bytes(), before)

    def test_paths_cannot_escape_vault(self):
        for payload in [
            {'topic': '../../outside', 'stem': 'note'},
            {'topic': 'Neurology', 'stem': '../../outside'},
            {'topic': 'Neurology', 'citekey': '../../outside'},
        ]:
            reply, = self.exchange({'action': 'save_reading_note', 'payload': dict(payload, content='synthetic')})
            self.assertEqual(reply['status'], 'error')
            self.assertIn('Invalid', reply['message'])
        self.assertEqual(list(self.vault.rglob('*.md')), [])

    def test_extension_id_validation(self):
        result = subprocess.run(self.args + ['--extension-id', '../../invalid'], env=self.env,
                                capture_output=True, text=True, timeout=20)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Extension ID', result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
