"""
Cohesive Ingestion Core for OB-Zotero literature management.
Unifies identification, matching, preview, execution, and resumability.
"""

from pathlib import Path
from .runtime_config import get_vault_root, get_vault_name
from typing import Any, Dict, Optional

from .identifier import extract_note_identity, extract_pdf_identity, normalize_doi
from .matcher import match_and_plan
from .metadata_client import MetadataClient
from .models import IngestPlan, MatchStatus, StepStatus
from .note_updater import update_note_frontmatter
from .state_tracker import IngestionStateTracker
from .zotero_client import ZoteroClient


class IngestionCore:
    def __init__(
        self,
        metadata_client: Optional[MetadataClient] = None,
        zotero_client: Optional[ZoteroClient] = None,
        state_tracker: Optional[IngestionStateTracker] = None,
    ):
        self.metadata_client = metadata_client or MetadataClient()
        self.zotero_client = zotero_client or ZoteroClient()
        self.state_tracker = state_tracker or IngestionStateTracker()

    def plan_ingest(
        self,
        pdf_path: Optional[Path] = None,
        note_path: Optional[Path] = None,
    ) -> IngestPlan:
        """
        Analyze files and produce a structured IngestPlan without modifying anything.
        """
        pdf_id = extract_pdf_identity(pdf_path) if pdf_path else None
        note_id = extract_note_identity(note_path) if note_path else None

        return match_and_plan(
            pdf=pdf_id,
            note=note_id,
            metadata_client=self.metadata_client,
            zotero_client=self.zotero_client,
        )

    def apply_plan(
        self,
        plan: IngestPlan,
        vault_name: Optional[str] = None,
        create_zotero_items: bool = False,
    ) -> Dict[str, Any]:
        """
        Apply the planned actions:
        1. Zotero item creation / attachment / backlink (if Zotero available)
        2. Obsidian note frontmatter in-place update
        3. Multi-step state tracking
        """
        if plan.match_status == MatchStatus.CONFLICT:
            raise ValueError(f"Cannot apply plan with conflict: {plan.warnings}")

        results: Dict[str, Any] = {
            "ob_updated": False,
            "zotero_key": plan.zotero_key,
            "zotero_created": False,
            "attachment_added": False,
            "backlink_added": False,
            "errors": [],
        }

        # Primary ID for state tracking
        primary_id = (
            plan.metadata.doi
            or (f"pmid:{plan.metadata.pmid}" if plan.metadata.pmid else None)
            or (plan.pdf.file_hash if plan.pdf else None)
            or (plan.note.filename if plan.note else "unknown")
        )
        state = self.state_tracker.get_or_create(
            paper_id=primary_id,
            doi=plan.metadata.doi,
            pmid=plan.metadata.pmid,
        )
        if plan.pdf:
            state.pdf_path = str(plan.pdf.path)
            state.pdf_hash = plan.pdf.file_hash
        if plan.note:
            state.note_path = str(plan.note.path)

        # ── 1. Zotero Execution ──
        zotero_key = plan.zotero_key
        zot_status = self.zotero_client.get_status()
        can_write_zotero = bool(zot_status.get("can_write", zot_status.get("web_api")))

        if zot_status["mode"] != "offline":
            # 1a. Create Zotero item if needed
            if not zotero_key:
                if create_zotero_items and can_write_zotero:
                    try:
                        new_key = self.zotero_client.create_item(plan.metadata)
                        if new_key:
                            zotero_key = new_key
                            results["zotero_key"] = new_key
                            results["zotero_created"] = True
                            self.state_tracker.mark_zotero_item_done(primary_id, new_key)
                        else:
                            results["errors"].append("Failed to create Zotero item.")
                            self.state_tracker.mark_failed(primary_id, "zotero_item", "Create item returned empty key")
                    except Exception as e:
                        results["errors"].append(f"Zotero create error: {e}")
                        self.state_tracker.mark_failed(primary_id, "zotero_item", str(e))
                elif create_zotero_items and not can_write_zotero:
                    results["errors"].append("Zotero Web API is not configured; cannot create new Zotero items.")
            else:
                self.state_tracker.mark_zotero_item_done(primary_id, zotero_key)

            # 1b. Upload PDF attachment if needed
            if zotero_key and plan.pdf:
                # Check if action requires adding attachment
                needs_att = any(
                    a.target == "Attachment" and a.category == "新增" for a in plan.actions
                )
                if needs_att and can_write_zotero:
                    try:
                        att_key = self.zotero_client.add_pdf_attachment(zotero_key, plan.pdf.path)
                        if att_key:
                            results["attachment_added"] = True
                            self.state_tracker.mark_zotero_att_done(primary_id)
                        else:
                            self.state_tracker.mark_failed(primary_id, "zotero_att", "Failed to add PDF attachment")
                    except Exception as e:
                        results["errors"].append(f"Zotero attachment error: {e}")
                        self.state_tracker.mark_failed(primary_id, "zotero_att", str(e))
                elif not needs_att and any(
                    a.target == "Attachment" and a.category == "沿用" for a in plan.actions
                ):
                    self.state_tracker.mark_zotero_att_done(primary_id)

            # 1c. Add OB backlink to Zotero
            if zotero_key and plan.note:
                needs_backlink = any(
                    a.target == "Zotero" and "返回 OB" in a.description and a.category == "新增"
                    for a in plan.actions
                )
                if needs_backlink and can_write_zotero:
                    try:
                        link_key = self.zotero_client.add_obsidian_backlink(
                            zotero_key, plan.note.path, vault_name=vault_name or get_vault_name()
                        )
                        if link_key:
                            results["backlink_added"] = True
                            self.state_tracker.mark_zotero_link_done(primary_id)
                    except Exception as e:
                        results["errors"].append(f"Zotero backlink error: {e}")
                elif not needs_backlink and any(
                    a.target == "Zotero" and "回連" in a.description and a.category == "沿用"
                    for a in plan.actions
                ):
                    self.state_tracker.mark_zotero_link_done(primary_id)
        else:
            # Zotero offline
            results["errors"].append("Zotero is offline. Zotero steps marked pending.")

        # ── 2. Obsidian In-Place Note Update ──
        if plan.note:
            ob_updates = {}
            if plan.metadata.citekey:
                ob_updates["citekey"] = plan.metadata.citekey
            if zotero_key:
                ob_updates["zotero"] = f"zotero://select/library/items/{zotero_key}"
            if plan.metadata.doi:
                ob_updates["doi"] = plan.metadata.doi
            if plan.metadata.pmid:
                ob_updates["pmid"] = plan.metadata.pmid
            if plan.metadata.authors and not plan.note.existing_frontmatter.get("authors"):
                ob_updates["authors"] = plan.metadata.authors
            if plan.metadata.journal and not plan.note.existing_frontmatter.get("journal"):
                ob_updates["journal"] = plan.metadata.journal
            if plan.metadata.year and not plan.note.existing_frontmatter.get("year"):
                ob_updates["year"] = plan.metadata.year

            if plan.pdf and "pdf" not in plan.note.existing_frontmatter:
                try:
                    vault_root = get_vault_root()
                    rel_pdf = plan.pdf.path.relative_to(vault_root).as_posix()
                    ob_updates["pdf"] = rel_pdf
                except Exception:
                    ob_updates["pdf"] = str(plan.pdf.path)

            try:
                changed, _, applied_changes, _ = update_note_frontmatter(
                    plan.note.path,
                    ob_updates,
                    dry_run=False,
                )
                results["ob_updated"] = changed
                results["applied_ob_changes"] = applied_changes
                self.state_tracker.mark_ob_done(
                    primary_id,
                    str(plan.note.path),
                    citekey=plan.metadata.citekey,
                )
            except Exception as e:
                results["errors"].append(f"Obsidian note update error: {e}")
                self.state_tracker.mark_failed(primary_id, "ob", str(e))

        return results
