"""
Gemini API Client for automated /read-paper deep reading note generation.
Uses Google Gemini latest models (gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash)
via official REST API endpoints to generate Cochrane RoB 2.0 / GRADE / 4-stage notes.
"""

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    from .identifier import normalize_doi, normalize_pmid, parse_frontmatter
    from .models import PaperMetadata
    from .runtime_config import RUNTIME_DIR, load_settings
except ImportError:
    from ingestion.identifier import normalize_doi, normalize_pmid, parse_frontmatter
    from ingestion.models import PaperMetadata
    from ingestion.runtime_config import RUNTIME_DIR, load_settings

# Base paths
BASE_DIR = Path(__file__).parent.parent.parent.resolve()
SCRIPTS_DIR = BASE_DIR / "scripts"
CONFIG_FILE = RUNTIME_DIR / "gemini.json"

LATEST_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
]


class GeminiClient:
    def __init__(self, api_key: Optional[str] = None, model: str = "gemini-2.5-flash"):
        self.api_key = api_key or self._load_api_key()
        self.model = model or "gemini-2.5-flash"
        self.timeout = 60

    def _load_api_key(self) -> Optional[str]:
        # 1. Check .gemini_config.json
        if CONFIG_FILE.exists():
            try:
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                key = data.get("api_key")
                if key and str(key).strip():
                    if data.get("model"):
                        self.model = data.get("model")
                    return str(key).strip()
            except Exception:
                pass

        # 2. Check .env in scripts/
        env_file = RUNTIME_DIR / ".env"
        if env_file.exists():
            try:
                for line in env_file.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY=") or line.startswith("GOOGLE_API_KEY="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
            except Exception:
                pass

        # 3. Check environment variable
        return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    def save_config(self, api_key: str, model: Optional[str] = None) -> bool:
        """Save API key and preferred model to .gemini_config.json securely."""
        try:
            cfg = {"api_key": api_key.strip(), "model": model or self.model}
            CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
            CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
            os.chmod(CONFIG_FILE, 0o600)
            self.api_key = api_key.strip()
            if model:
                self.model = model
            return True
        except Exception as e:
            logging.error(f"Failed to save Gemini config: {e}")
            return False

    def is_available(self) -> bool:
        return bool(self.api_key and len(self.api_key) > 5)

    def get_status(self) -> Dict[str, Any]:
        has_key = self.is_available()
        masked_key = f"{self.api_key[:4]}...{self.api_key[-4:]}" if has_key and len(self.api_key) > 8 else None
        return {
            "available": has_key,
            "masked_key": masked_key,
            "current_model": self.model,
            "available_models": LATEST_MODELS,
        }

    def _get_read_paper_system_instruction(self) -> str:
        """Load the comprehensive /read-paper prompt guidelines."""
        try:
            prompt_path = load_settings().get("reading_prompt")
            skill_file = Path(prompt_path).expanduser().resolve() if prompt_path else None
            if skill_file and skill_file.exists():
                return skill_file.read_text(encoding="utf-8")
        except Exception:
            pass

        # Fallback standard prompt if file not found
        return """
你是一位頂尖醫學研究評讀專家。請閱讀以下學術論文全文，依照「四階段深度評讀模型」以台灣繁體中文建立專業閱讀筆記：
1. 縮寫對照表 (Glossary)
2. 重要臨床提問 (Key Clinical Questions，4-6題)
3. 研究背景與目的 (Background)
4. 方法與收案 (Methods & Cohort)
5. 研究品質評估 (Critical Appraisal):
   - 研究設計識別 (如 RCT, 世代研究)
   - Cochrane RoB 2.0 或對應評讀工具 (偏差風險等級與理由)
   - GRADE 證據等級 (⊕⊕⊕⊕ 高至極低)
6. 主要研究結果 (Key Findings，含關鍵統計數值、HR/RR/OR、95% CI、p值)
7. 臨床意涵與討論 (Clinical Implications，PICO 適用性、NNT 計算、對台灣臨床直接意涵)
8. Key Takeaways 與深度問答 (Deep Q&A)
要求：全程繁體中文，保留學術嚴謹度，關鍵數值不遺漏，藥物學名保留英文。
"""

    def generate_reading_note(
        self,
        meta: PaperMetadata,
        sections: List[Dict[str, Any]],
        tables: Optional[List[Dict[str, Any]]] = None,
        model: Optional[str] = None,
    ) -> Tuple[bool, str]:
        """
        Call Gemini API to generate the full /read-paper reading note.
        Returns (success: bool, note_markdown_or_error: str).
        """
        if not self.is_available():
            return False, "未設定 Gemini API Key，請先設定 API Key。"

        selected_model = model or self.model or "gemini-2.5-flash"
        system_instruction = self._get_read_paper_system_instruction()

        # Build article payload for Gemini
        article_parts = []
        article_parts.append(f"# Title: {meta.title}")
        article_parts.append(f"Authors: {meta.authors}")
        article_parts.append(f"Journal: {meta.journal} ({meta.year})")
        if meta.doi:
            article_parts.append(f"DOI: {meta.doi}")
        if meta.pmid:
            article_parts.append(f"PMID: {meta.pmid}")
        if meta.abstract:
            article_parts.append(f"\n## Abstract\n{meta.abstract}")

        if sections:
            article_parts.append("\n## Full-Text Sections")
            for sec in sections:
                heading = sec.get("heading", "").strip()
                text = sec.get("text", "").strip()
                if heading:
                    article_parts.append(f"\n### {heading}\n{text}")

        if tables:
            article_parts.append("\n## Tables")
            for tbl in tables:
                caption = tbl.get("caption", "Table")
                md = tbl.get("markdown", "")
                article_parts.append(f"\n### {caption}\n{md}")

        full_article_text = "\n\n".join(article_parts)

        # Candidate models to try in sequence if preferred model fails
        models_to_try = [selected_model]
        for fallback in ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"]:
            if fallback not in models_to_try:
                models_to_try.append(fallback)

        last_error = ""
        for mod in models_to_try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{mod}:generateContent?key={self.api_key}"
            payload = {
                "system_instruction": {
                    "parts": [{"text": system_instruction}]
                },
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {
                                "text": f"請依照 /read-paper 規範，針對以下論文全文進行四階段深度評讀並輸出完整閱讀筆記 Markdown：\n\n{full_article_text}"
                            }
                        ]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.2,
                    "maxOutputTokens": 8192,
                }
            }

            try:
                logging.info(f"Calling Gemini API with model: {mod}...")
                r = requests.post(url, json=payload, timeout=self.timeout)
                if r.status_code == 200:
                    resp_data = r.json()
                    candidates = resp_data.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        if parts:
                            generated_text = parts[0].get("text", "").strip()
                            # Clean markdown formatting tags if wrapped in ```markdown
                            if generated_text.startswith("```markdown"):
                                generated_text = generated_text[11:].strip()
                            if generated_text.startswith("```"):
                                generated_text = generated_text[3:].strip()
                            if generated_text.endswith("```"):
                                generated_text = generated_text[:-3].strip()

                            logging.info(f"Gemini API ({mod}) successfully generated {len(generated_text)} characters.")
                            return True, generated_text
                else:
                    err_msg = r.text[:200]
                    logging.warning(f"Gemini API model {mod} returned {r.status_code}: {err_msg}")
                    last_error = f"HTTP {r.status_code}: {err_msg}"
            except Exception as e:
                logging.warning(f"Error calling Gemini API ({mod}): {e}")
                last_error = str(e)

        return False, f"呼叫 Gemini API 失敗 ({last_error})"
