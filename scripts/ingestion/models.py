"""
Data models for OB-Zotero Ingestion Core.
"""

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional


class MatchStatus(str, Enum):
    NEW = "NEW"                           # 新增
    REUSE = "REUSE"                       # 沿用
    PENDING_CONFIRMATION = "PENDING"      # 待確認
    CONFLICT = "CONFLICT"                 # 衝突


class StepStatus(str, Enum):
    PENDING = "pending"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class PaperMetadata:
    title: str = ""
    authors: str = ""
    journal: str = ""
    year: Optional[int] = None
    doi: Optional[str] = None
    pmid: Optional[str] = None
    abstract: str = ""
    url: Optional[str] = None
    citekey: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "title": self.title,
            "authors": self.authors,
            "journal": self.journal,
            "year": self.year,
            "doi": self.doi,
            "pmid": self.pmid,
            "abstract": self.abstract,
            "url": self.url,
            "citekey": self.citekey,
        }


@dataclass
class PDFIdentity:
    path: Path
    filename: str
    file_hash: str
    file_size: int
    extracted_doi: Optional[str] = None
    extracted_pmid: Optional[str] = None
    candidate_dois: List[str] = field(default_factory=list)
    is_supplementary: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "filename": self.filename,
            "file_hash": self.file_hash,
            "file_size": self.file_size,
            "extracted_doi": self.extracted_doi,
            "extracted_pmid": self.extracted_pmid,
            "candidate_dois": self.candidate_dois,
            "is_supplementary": self.is_supplementary,
        }



@dataclass
class NoteIdentity:
    path: Path
    filename: str
    extracted_doi: Optional[str] = None
    extracted_pmid: Optional[str] = None
    citekey: Optional[str] = None
    zotero_link: Optional[str] = None
    has_frontmatter: bool = False
    existing_frontmatter: Dict[str, Any] = field(default_factory=dict)
    body: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": str(self.path),
            "filename": self.filename,
            "extracted_doi": self.extracted_doi,
            "extracted_pmid": self.extracted_pmid,
            "citekey": self.citekey,
            "zotero_link": self.zotero_link,
            "has_frontmatter": self.has_frontmatter,
        }


@dataclass
class PlanAction:
    category: str  # "新增", "沿用", "待確認", "跳過"
    description: str
    target: str    # "OB", "Zotero", "Attachment"
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class IngestPlan:
    match_status: MatchStatus
    metadata: PaperMetadata
    pdf: Optional[PDFIdentity] = None
    note: Optional[NoteIdentity] = None
    zotero_key: Optional[str] = None
    actions: List[PlanAction] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def can_apply(self) -> bool:
        return self.match_status in (MatchStatus.NEW, MatchStatus.REUSE) and not any(
            "CRITICAL" in w for w in self.warnings
        )


@dataclass
class PaperState:
    id: str  # primary identifier: normalized DOI or PMID or file hash
    doi: Optional[str] = None
    pmid: Optional[str] = None
    pdf_path: Optional[str] = None
    pdf_hash: Optional[str] = None
    note_path: Optional[str] = None
    citekey: Optional[str] = None
    zotero_key: Optional[str] = None
    ob_status: StepStatus = StepStatus.PENDING
    zotero_item_status: StepStatus = StepStatus.PENDING
    zotero_att_status: StepStatus = StepStatus.PENDING
    zotero_link_status: StepStatus = StepStatus.PENDING
    last_updated: str = ""
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "doi": self.doi,
            "pmid": self.pmid,
            "pdf_path": self.pdf_path,
            "pdf_hash": self.pdf_hash,
            "note_path": self.note_path,
            "citekey": self.citekey,
            "zotero_key": self.zotero_key,
            "ob_status": self.ob_status.value if hasattr(self.ob_status, "value") else str(self.ob_status),
            "zotero_item_status": self.zotero_item_status.value if hasattr(self.zotero_item_status, "value") else str(self.zotero_item_status),
            "zotero_att_status": self.zotero_att_status.value if hasattr(self.zotero_att_status, "value") else str(self.zotero_att_status),
            "zotero_link_status": self.zotero_link_status.value if hasattr(self.zotero_link_status, "value") else str(self.zotero_link_status),
            "last_updated": self.last_updated,
            "error_message": self.error_message,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PaperState":
        return cls(
            id=data.get("id", ""),
            doi=data.get("doi"),
            pmid=data.get("pmid"),
            pdf_path=data.get("pdf_path"),
            pdf_hash=data.get("pdf_hash"),
            note_path=data.get("note_path"),
            citekey=data.get("citekey"),
            zotero_key=data.get("zotero_key"),
            ob_status=StepStatus(data.get("ob_status", "pending")),
            zotero_item_status=StepStatus(data.get("zotero_item_status", "pending")),
            zotero_att_status=StepStatus(data.get("zotero_att_status", "pending")),
            zotero_link_status=StepStatus(data.get("zotero_link_status", "pending")),
            last_updated=data.get("last_updated", ""),
            error_message=data.get("error_message"),
        )
