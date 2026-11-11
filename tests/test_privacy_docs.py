"""The GitHub Pages privacy page stays a copy of PRIVACY.md."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PrivacyDocsTests(unittest.TestCase):
    def test_pages_privacy_matches_policy(self):
        policy = (ROOT / "PRIVACY.md").read_text(encoding="utf-8")
        page = (ROOT / "docs/privacy.md").read_text(encoding="utf-8")
        front, _, body = page.partition("\n---\n")
        self.assertTrue(front.startswith("---\n"))
        self.assertIn("permalink: /privacy/", front)
        self.assertIn("layout: page", front)
        self.assertEqual(body.lstrip("\n"), policy)
        self.assertIn("**生效日期 / Effective date:** 2026-11-11", policy)
        self.assertIn("https://github.com/t0mst0ne/ob-zotero-ingest/issues", policy)
        for endpoint in (
            "https://api.crossref.org/works/{doi}",
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            "https://api.unpaywall.org/v2/{doi}?email=academic-ingest@ob-vault.local",
            "https://api.openalex.org/works/https://doi.org/{doi}",
            "https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}?fields=openAccessPdf",
            "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
            "https://europepmc.org/backend/ptpmcrender.fcgi?accid={pmcid}&blobtype=pdf",
            "https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/pdf/",
            "https://www.biorxiv.org/content/{doi}.full.pdf",
            "https://api.zotero.org/users/{user_id}/items",
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            "http://localhost:23119/api/application",
        ):
            self.assertIn(endpoint, policy)

    def test_pages_config_and_index(self):
        config = (ROOT / "docs/_config.yml").read_text(encoding="utf-8")
        index = (ROOT / "docs/index.md").read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        store = (ROOT / "CHROME_WEB_STORE.md").read_text(encoding="utf-8")
        self.assertIn("theme: minima", config)
        self.assertIn('baseurl: "/ob-zotero-ingest"', config)
        self.assertIn("](privacy/)", index)
        self.assertIn("https://t0mst0ne.github.io/ob-zotero-ingest/privacy/", readme)
        self.assertIn("https://t0mst0ne.github.io/ob-zotero-ingest/privacy/", store)
        self.assertIn("--extension-id <chrome-web-store-id>", store)
        self.assertIn("Website content | **Yes**", store)
        self.assertNotIn("**No data collected**", store)
