"""
Persistent multi-step state tracker for OB-Zotero Ingestion.
Enables resilient resume/retry of interrupted steps without duplicating work.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .models import PaperState, StepStatus
from .runtime_config import RUNTIME_DIR

DEFAULT_STATE_FILE = RUNTIME_DIR / "ingest_state.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class IngestionStateTracker:
    def __init__(self, state_file: Optional[Path] = None):
        self.state_file = state_file or DEFAULT_STATE_FILE
        self._states: Dict[str, PaperState] = {}
        self._load()

    def _load(self) -> None:
        if self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                for pid, s_data in data.items():
                    self._states[pid] = PaperState.from_dict(s_data)
            except Exception:
                self._states = {}

    def save(self) -> None:
        data = {pid: s.to_dict() for pid, s in self._states.items()}
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def get_state(self, paper_id: str) -> Optional[PaperState]:
        return self._states.get(paper_id)

    def get_or_create(self, paper_id: str, doi: Optional[str] = None, pmid: Optional[str] = None) -> PaperState:
        if paper_id not in self._states:
            self._states[paper_id] = PaperState(
                id=paper_id,
                doi=doi,
                pmid=pmid,
                last_updated=_now_iso(),
            )
        return self._states[paper_id]

    def update_state(self, state: PaperState) -> None:
        state.last_updated = _now_iso()
        self._states[state.id] = state
        self.save()

    def mark_ob_done(self, paper_id: str, note_path: str, citekey: Optional[str] = None) -> None:
        state = self.get_or_create(paper_id)
        state.ob_status = StepStatus.DONE
        state.note_path = note_path
        if citekey:
            state.citekey = citekey
        self.update_state(state)

    def mark_zotero_item_done(self, paper_id: str, zotero_key: str) -> None:
        state = self.get_or_create(paper_id)
        state.zotero_item_status = StepStatus.DONE
        state.zotero_key = zotero_key
        self.update_state(state)

    def mark_zotero_att_done(self, paper_id: str) -> None:
        state = self.get_or_create(paper_id)
        state.zotero_att_status = StepStatus.DONE
        self.update_state(state)

    def mark_zotero_link_done(self, paper_id: str) -> None:
        state = self.get_or_create(paper_id)
        state.zotero_link_status = StepStatus.DONE
        self.update_state(state)

    def mark_failed(self, paper_id: str, step: str, error_msg: str) -> None:
        state = self.get_or_create(paper_id)
        if step == "ob":
            state.ob_status = StepStatus.FAILED
        elif step == "zotero_item":
            state.zotero_item_status = StepStatus.FAILED
        elif step == "zotero_att":
            state.zotero_att_status = StepStatus.FAILED
        elif step == "zotero_link":
            state.zotero_link_status = StepStatus.FAILED
        state.error_message = f"[{step}] {error_msg}"
        self.update_state(state)

    def get_pending_or_failed_papers(self) -> List[PaperState]:
        """Return all papers that have uncompleted steps."""
        results = []
        for state in self._states.values():
            steps = (state.ob_status, state.zotero_item_status, state.zotero_att_status, state.zotero_link_status)
            if any(s in (StepStatus.PENDING, StepStatus.FAILED) for s in steps):
                results.append(state)
        return results
