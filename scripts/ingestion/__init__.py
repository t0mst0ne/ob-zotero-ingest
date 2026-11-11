"""
OB-Zotero Shared Ingestion Core
"""

from .models import (
    PaperMetadata,
    PDFIdentity,
    NoteIdentity,
    IngestPlan,
    PlanAction,
    MatchStatus,
    StepStatus,
    PaperState,
)
from .identifier import extract_pdf_identity, extract_note_identity, normalize_doi
from .matcher import match_and_plan
from .note_updater import update_note_frontmatter
from .state_tracker import IngestionStateTracker
from .core import IngestionCore

__all__ = [
    "PaperMetadata",
    "PDFIdentity",
    "NoteIdentity",
    "IngestPlan",
    "PlanAction",
    "MatchStatus",
    "StepStatus",
    "PaperState",
    "extract_pdf_identity",
    "extract_note_identity",
    "normalize_doi",
    "match_and_plan",
    "update_note_frontmatter",
    "IngestionStateTracker",
    "IngestionCore",
]
