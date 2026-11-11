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

    def test_markdown_and_pdf_note_cleaning_and_html_inline_preservation(self):
        # 1. Plain Markdown with inequality operators and PDF line wraps when both is_html and is_pdf are True
        md_input = "## 1. Findings\nStatistically significant (p < 0.001 and HR > 1.5) in inter-\nvention group."
        saved_md, = self.exchange({'action': 'save_reading_note', 'payload': {
            'topic': 'Neurology', 'stem': 'stat_test', 'target_type': 'note',
            'content': md_input, 'is_html': True, 'is_pdf': True,
        }})
        self.assertEqual(saved_md['status'], 'success', saved_md)
        note_text = (self.vault / saved_md['note_path']).read_text(encoding='utf-8')
        self.assertIn('## 1. Findings\nStatistically significant (p < 0.001 and HR > 1.5) in intervention group.', note_text)

        # 2. HTML with inline strong/em/code and row-header th inside table
        html_input = (
            '<p>Primary outcome: <strong>HR 0.72</strong> (<em>95% CI</em>, <code>p=0.002</code>).</p>'
            '<table><tr><th>Group</th><th>Events</th></tr>'
            '<tr><th>Treatment</th><td>12</td></tr></table>'
        )
        saved_html, = self.exchange({'action': 'save_reading_note', 'payload': {
            'topic': 'Neurology', 'stem': 'html_test', 'target_type': 'note',
            'content': html_input, 'is_html': True, 'is_pdf': True,
        }})
        self.assertEqual(saved_html['status'], 'success', saved_html)
        html_note_text = (self.vault / saved_html['note_path']).read_text(encoding='utf-8')
        self.assertIn('**HR 0.72**', html_note_text)
        self.assertIn('*95% CI*', html_note_text)
        self.assertIn('`p=0.002`', html_note_text)
        self.assertIn('| Treatment | 12 |', html_note_text)

    def test_yaml_quoting_and_state_persistence_and_complex_doi_stem(self):
        from pypdf import PdfWriter
        pdf = PdfWriter()
        pdf.add_blank_page(width=600, height=800)
        pdf.add_metadata({'/Title': 'Complex DOI PDF ' * 120})
        buf = io.BytesIO()
        pdf.write(buf)
        pdf_bytes = buf.getvalue()
        b64 = base64.b64encode(pdf_bytes).decode()

        uploaded_stem = '10.1016_s0140-6736_24_00123-4_Smith_Quoted_Title_2026'
        up, = self.exchange({'action': 'upload_pdf_chunk', 'payload': {
            'transfer_id': 'complex-doi', 'chunk_index': 0, 'total_chunks': 1,
            'chunk_base64': b64, 'topic': 'Neurology', 'stem': uploaded_stem,
        }})
        self.assertEqual(up['status'], 'success', up)

        reply, = self.exchange({'action': 'ingest_webpage', 'payload': {
            'metadata': {
                'title': 'A "Quoted" Title: Sub-study',
                'authors': 'Smith J.',
                'journal': 'The "Lancet" Neurology',
                'year': 2026,
                'doi': '10.1016/s0140-6736(24)00123-4',
                'url': 'https://example.org/lancet',
            },
            'sections': [{'heading': 'Methods', 'level': 2, 'text': 'Study body.'}],
            'figures': [], 'tables': [],
            'uploaded_pdf_stem': uploaded_stem,
            'options': {
                'topic': 'Neurology', 'save_source': True, 'save_note': True,
                'download_pdf': True, 'download_figures': False, 'save_zotero': False,
            },
        }})
        self.assertEqual(reply['status'], 'success', reply)
        self.assertTrue(reply['pdf']['saved'])
        self.assertEqual(parse_qs(urlparse(reply['pdf']['obsidian_uri']).query)['vault'], ['Clean & 測試 Vault'])

        # Verify YAML frontmatter is valid and parseable
        sys.path.insert(0, str(ROOT / 'scripts'))
        from ingestion.identifier import extract_note_identity
        note_id = extract_note_identity(self.vault / reply['note']['path'])
        self.assertTrue(note_id.has_frontmatter)
        self.assertEqual(note_id.existing_frontmatter.get('journal'), 'The "Lancet" Neurology')

        source_id = extract_note_identity(self.vault / reply['source']['path'])
        self.assertTrue(source_id.has_frontmatter)
        self.assertEqual(source_id.existing_frontmatter.get('title'), 'A "Quoted" Title: Sub-study')

        # Verify source_path is persisted in ingest_state.json
        state_data = json.loads((self.config / 'ingest_state.json').read_text(encoding='utf-8'))
        primary_state = state_data['10.1016/s0140-6736(24)00123-4']
        self.assertTrue(primary_state.get('source_path', '').endswith('.md'))

    def test_matcher_and_package_extension_store_readiness(self):
        # Verify relative imports work when importing scripts.ingestion.gemini_client from ROOT
        res = subprocess.run(
            [sys.executable, '-I', '-c',
             f'import sys; sys.path.insert(0, {str(ROOT)!r}); import scripts.ingestion.gemini_client'],
            env=self.env, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(res.returncode, 0, res.stderr)

        # Verify matcher preprint fallback uses note.existing_frontmatter without AttributeError
        sys.path.insert(0, str(ROOT / 'scripts'))
        from ingestion.matcher import match_and_plan
        from ingestion.models import NoteIdentity, PDFIdentity, MatchStatus

        class OfflineMetadataClient:
            def fetch_metadata(self, doi=None, pmid=None):
                return None

        class OfflineZoteroClient:
            def get_status(self):
                return {'web_api': False, 'local_api': False, 'local_sqlite': True, 'can_write': False, 'mode': 'local_sqlite'}
            def find_item_by_doi(self, doi):
                return {'key': 'ZOT12345'}
            def find_item_by_pmid(self, pmid):
                return None
            def find_existing_attachments(self, key):
                return [{'data': {'filename': 'paper.pdf', 'url': 'obsidian://open?vault=OB&file=note.md'}}]

        note = NoteIdentity(
            path=self.vault / 'note.md',
            filename='note.md',
            extracted_doi='10.1101/2025.01.01.123456',
            has_frontmatter=True,
            existing_frontmatter={'title': 'Deep learning in neuroimaging'},
        )
        pdf = PDFIdentity(
            path=self.vault / 'paper.pdf',
            filename='paper.pdf',
            file_hash='abc123',
            file_size=2048,
            extracted_doi='10.1038/s41591-025-00001-1',
        )
        plan = match_and_plan(pdf, note, OfflineMetadataClient(), OfflineZoteroClient())
        self.assertEqual(plan.match_status, MatchStatus.CONFLICT)
        self.assertTrue(any('預印本' in w for w in plan.warnings))

        # Verify local attachment URL recognition avoids duplicate OB backlink
        note_same = NoteIdentity(
            path=self.vault / 'note.md',
            filename='note.md',
            extracted_doi='10.1038/s41591-025-00001-1',
            has_frontmatter=True,
            existing_frontmatter={'title': 'Deep learning in neuroimaging'},
        )
        plan_reuse = match_and_plan(pdf, note_same, OfflineMetadataClient(), OfflineZoteroClient())
        self.assertTrue(any(a.category == '沿用' and '回連' in a.description for a in plan_reuse.actions))

        # Verify package_extension.py produces a store-ready manifest without 'key' or 'cookies'
        pkg = subprocess.run(
            [sys.executable, '-I', str(ROOT / 'scripts/package_extension.py')],
            env=self.env, capture_output=True, text=True, timeout=20, check=True,
        )
        pkg_info = json.loads(pkg.stdout)
        self.assertTrue(pkg_info['store_ready_manifest'])

    def test_metadata_client_merges_pubmed_and_crossref_and_caches_pmid(self):
        sys.path.insert(0, str(ROOT / 'scripts'))
        from ingestion.metadata_client import MetadataClient
        from ingestion.models import PaperMetadata

        cache_file = self.config / 'cache' / 'test_meta_cache.json'
        client = MetadataClient(cache_file=cache_file)

        # Pre-populate cache with PubMed (no abstract) and CrossRef (has abstract + URL)
        client._cache['pmid:38000001'] = PaperMetadata(
            title='Clinical Trial', authors='Lin C.', journal='NEJM',
            year=2025, doi='10.1056/nejmoa2500001', pmid='38000001', abstract='',
        ).to_dict()
        client._cache['doi:10.1056/nejmoa2500001'] = PaperMetadata(
            title='Clinical Trial', authors='Lin C.', journal='NEJM',
            year=2025, doi='10.1056/nejmoa2500001', pmid=None,
            abstract='Full structured abstract.', url='https://www.nejm.org/doi/full/10.1056/nejmoa2500001',
        ).to_dict()

        merged = client.fetch_metadata(doi='10.1056/nejmoa2500001', pmid='38000001')
        self.assertIsNotNone(merged)
        self.assertEqual(merged.pmid, '38000001')
        self.assertEqual(merged.abstract, 'Full structured abstract.')
        self.assertEqual(merged.url, 'https://www.nejm.org/doi/full/10.1056/nejmoa2500001')
        self.assertEqual(client._cache['doi:10.1056/nejmoa2500001']['pmid'], '38000001')


if __name__ == '__main__':
    unittest.main(verbosity=2)
