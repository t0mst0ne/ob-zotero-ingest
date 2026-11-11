"""
Matching and planning engine for OB-Zotero Ingestion.
Coordinates Note vs PDF cross-checking, Zotero querying, and change preview generation.
"""

from pathlib import Path
from typing import Dict, List, Optional

from .identifier import normalize_doi, normalize_pmid
from .metadata_client import MetadataClient, generate_citekey
from .models import (
    IngestPlan,
    MatchStatus,
    NoteIdentity,
    PaperMetadata,
    PDFIdentity,
    PlanAction,
)
from .zotero_client import ZoteroClient


def is_preprint_doi(doi: Optional[str]) -> bool:
    """Check if a DOI belongs to a preprint server."""
    if not doi:
        return False
    doi_lower = doi.lower()
    return any(doi_lower.startswith(p) for p in (
        "10.1101/",       # bioRxiv / medRxiv
        "10.21203/",      # Research Square
        "10.20944/",      # Preprints.org
        "10.22541/",      # Authorea
        "10.31219/",      # OSF Preprints
        "10.48550/arxiv", # arXiv
    ))


def title_similarity(t1: Optional[str], t2: Optional[str]) -> float:
    """Compute word-overlap similarity between two titles."""
    if not t1 or not t2:
        return 0.0
    import re
    w1 = set(re.findall(r'[a-zA-Z0-9]+', t1.lower()))
    w2 = set(re.findall(r'[a-zA-Z0-9]+', t2.lower()))
    if not w1 or not w2:
        return 0.0
    return len(w1 & w2) / min(len(w1), len(w2))


def match_and_plan(
    pdf: Optional[PDFIdentity],
    note: Optional[NoteIdentity],
    metadata_client: MetadataClient,
    zotero_client: ZoteroClient,
) -> IngestPlan:
    """
    Generate an IngestPlan by cross-checking PDF and Note against metadata APIs and Zotero.
    """
    actions: List[PlanAction] = []
    warnings: List[str] = []
    status = MatchStatus.NEW

    note_doi = normalize_doi(note.extracted_doi) if note else None
    note_pmid = normalize_pmid(note.extracted_pmid) if note else None

    pdf_doi = normalize_doi(pdf.extracted_doi) if pdf else None
    pdf_pmid = normalize_pmid(pdf.extracted_pmid) if pdf else None

    # Step 1: Identity Resolution & Cross-Checking
    primary_doi = None
    primary_pmid = None

    if note and pdf:
        # Cross check Note and PDF
        # Check 1: Is Note's DOI in PDF's candidate DOIs?
        if note_doi and pdf.candidate_dois and note_doi in pdf.candidate_dois:
            primary_doi = note_doi
            if note_doi != pdf_doi:
                actions.append(PlanAction(
                    category="沿用",
                    description=f"PDF 內文中包含多個 DOI，已精確匹配筆記之論文 DOI ({note_doi})，排除評論或附錄 DOI",
                    target="OB",
                ))
        elif note_doi and pdf_doi:
            if note_doi == pdf_doi:
                primary_doi = note_doi
            elif pdf_doi.startswith(note_doi + ".") or pdf_doi.startswith(note_doi + "/"):
                # Note DOI is an incomplete prefix, upgrade to full PDF DOI
                primary_doi = pdf_doi
                actions.append(PlanAction(
                    category="新增",
                    description=f"筆記所記 DOI ({note_doi}) 似為不完整前綴，升級為完整 PDF DOI ({pdf_doi})",
                    target="OB",
                ))
            elif pdf_doi.startswith(note_doi):
                # PDF DOI contains trailing text from page layout
                primary_doi = note_doi
                actions.append(PlanAction(
                    category="沿用",
                    description=f"PDF 內容識別之 DOI ({pdf_doi}) 包含排版後綴，已精確校正為筆記官方 DOI ({note_doi})",
                    target="OB",
                ))
            elif note_doi.startswith(pdf_doi):
                # Note DOI is more complete than PDF DOI
                primary_doi = note_doi
                actions.append(PlanAction(
                    category="沿用",
                    description=f"沿用筆記完整 DOI ({note_doi})，PDF DOI 似為前綴截斷 ({pdf_doi})",
                    target="OB",
                ))
            elif note_pmid and pdf_pmid and note_pmid == pdf_pmid:
                # PMIDs match! Check PubMed official DOI to determine whether Note or PDF is correct
                pmid_meta = metadata_client.fetch_pubmed(note_pmid)
                official_doi = pmid_meta.doi.lower() if pmid_meta and pmid_meta.doi else None

                if official_doi and (official_doi == pdf_doi or pdf_doi.startswith(official_doi)):
                    # Note had a typo or outdated DOI, PDF has the official DOI
                    primary_doi = official_doi
                    actions.append(PlanAction(
                        category="新增",
                        description=f"PMID ({note_pmid}) 官方 DOI 為 {official_doi}，筆記 DOI ({note_doi}) 疑似誤植，建議校正為官方 DOI",
                        target="OB",
                    ))
                elif official_doi and official_doi == note_doi:
                    if pdf_doi.startswith(official_doi):
                        primary_doi = official_doi
                        actions.append(PlanAction(
                            category="沿用",
                            description=f"PDF 內容提取之 DOI ({pdf_doi}) 包含排版後綴，已精確校正為官方 DOI ({official_doi})",
                            target="OB",
                        ))
                    else:
                        # Note has the official DOI, but PDF content does NOT match the paper! (e.g. wrong PDF file)
                        status = MatchStatus.CONFLICT
                        warnings.append(
                            f"CRITICAL: PDF 內容提取之 DOI ({pdf_doi}) 與該文獻之官方 DOI ({official_doi}) 不一致！PDF 檔案內容疑似有誤或非本篇正文。"
                        )
                else:
                    if official_doi and pdf_doi.startswith(official_doi):
                        primary_doi = official_doi
                        actions.append(PlanAction(
                            category="新增",
                            description=f"PMID ({note_pmid}) 官方 DOI 為 {official_doi}，校正為官方 DOI",
                            target="OB",
                        ))
                    else:
                        status = MatchStatus.CONFLICT
                        warnings.append(
                            f"CRITICAL: PMID ({note_pmid}) 一致，但筆記 DOI ({note_doi}) 與 PDF 內容識別之 DOI ({pdf_doi}) 存在衝突。"
                        )

            else:
                # Check if one is a preprint and the other is a published journal version of the same paper
                is_note_preprint = is_preprint_doi(note_doi)
                is_pdf_preprint = is_preprint_doi(pdf_doi)
                if (is_note_preprint and not is_pdf_preprint) or (is_pdf_preprint and not is_note_preprint):
                    # Check title similarity between the two DOIs
                    m_note = metadata_client.fetch_metadata(doi=note_doi)
                    m_pdf = metadata_client.fetch_metadata(doi=pdf_doi)
                    t_note = m_note.title if m_note else (note.frontmatter.get("title") if note and note.frontmatter else "")
                    t_pdf = m_pdf.title if m_pdf else ""
                    sim = title_similarity(t_note, t_pdf) if (t_note and t_pdf) else 0.0

                    if sim >= 0.5:
                        if is_note_preprint:
                            # Note had preprint, upgrade to PDF published journal DOI
                            primary_doi = pdf_doi
                            if pdf_pmid:
                                primary_pmid = pdf_pmid
                            actions.append(PlanAction(
                                category="新增",
                                description=f"筆記所記為預印本 ({note_doi})，升級為正式期刊發表版本 DOI ({pdf_doi})",
                                target="OB",
                            ))
                        else:
                            # PDF was preprint, note already has formal published journal DOI
                            primary_doi = note_doi
                            if note_pmid:
                                primary_pmid = note_pmid
                            actions.append(PlanAction(
                                category="沿用",
                                description=f"保留筆記之正式期刊發表版本 DOI ({note_doi})，PDF 檔案為預印本版本 ({pdf_doi})",
                                target="OB",
                            ))
                    else:
                        status = MatchStatus.CONFLICT
                        warnings.append(
                            f"CRITICAL: 偵測到預印本與期刊發表版本差異但標題不符！筆記為 {note_doi}，PDF 為 {pdf_doi}。請人工核對。"
                        )
                else:
                    status = MatchStatus.CONFLICT
                    warnings.append(
                        f"CRITICAL: DOI 衝突！筆記記錄為 {note_doi}，但 PDF 識別為 {pdf_doi}。請人工核對。"
                    )
        elif note_doi and not pdf_doi:
            primary_doi = note_doi
            actions.append(PlanAction(category="沿用", description=f"沿用筆記中記錄之 DOI ({note_doi})", target="OB"))
        elif pdf_doi and not note_doi:
            primary_doi = pdf_doi
            actions.append(PlanAction(category="新增", description=f"自 PDF 提取之 DOI ({pdf_doi}) 將補登至筆記", target="OB"))

        # Check PMID
        if note_pmid and pdf_pmid:
            if note_pmid == pdf_pmid:
                primary_pmid = note_pmid
            elif primary_pmid:
                # Already resolved above (e.g. via preprint upgrade)
                pass
            else:
                warnings.append(f"PMID 不一致：筆記為 {note_pmid}，PDF 為 {pdf_pmid}")
                if not primary_doi:
                    status = MatchStatus.CONFLICT
        elif note_pmid and not primary_pmid:
            primary_pmid = note_pmid
        elif pdf_pmid and not primary_pmid:
            primary_pmid = pdf_pmid

    elif note:
        primary_doi = note_doi
        primary_pmid = note_pmid
    elif pdf:
        primary_doi = pdf_doi
        primary_pmid = pdf_pmid

    if not primary_doi and not primary_pmid:
        if status == MatchStatus.CONFLICT:
            warnings.append("文獻身分存在重大衝突，無法自動決定主識別碼，需由人工介入選取。")
        else:
            status = MatchStatus.PENDING_CONFIRMATION
            warnings.append("待確認：未能從檔案或筆記中抽取出 DOI 或 PMID，需手動指定後才能入庫。")



    # Step 2: Fetch / Synthesize Metadata
    meta: Optional[PaperMetadata] = None
    if primary_doi or primary_pmid:
        meta = metadata_client.fetch_metadata(doi=primary_doi, pmid=primary_pmid)

    if not meta:
        # Fallback to existing note frontmatter if API failed
        if note and note.has_frontmatter:
            fm = note.existing_frontmatter
            meta = PaperMetadata(
                title=str(fm.get("title", note.filename)),
                authors=str(fm.get("authors", "")),
                journal=str(fm.get("journal", "")),
                year=int(fm.get("year")) if str(fm.get("year", "")).isdigit() else None,
                doi=primary_doi or fm.get("doi"),
                pmid=primary_pmid or fm.get("pmid"),
            )
            meta.citekey = note.citekey or generate_citekey(meta)
            warnings.append("線上書目 API 未能回傳資料，沿用筆記現存 frontmatter。")
        else:
            meta = PaperMetadata(
                title=pdf.filename if pdf else "Unknown Title",
                doi=primary_doi,
                pmid=primary_pmid,
            )
            warnings.append("未能取得線上書目資料。")

    if not meta.citekey:
        meta.citekey = (note.citekey if note and note.citekey else None) or generate_citekey(meta)

    # Step 3: Zotero Matching & Planning
    zot_status = zotero_client.get_status()
    zotero_key: Optional[str] = None
    existing_zotero_item = None

    if zot_status.get("web_api") or zot_status.get("local_api"):
        if primary_doi:
            existing_zotero_item = zotero_client.find_item_by_doi(primary_doi)
        if not existing_zotero_item and primary_pmid:
            existing_zotero_item = zotero_client.find_item_by_pmid(primary_pmid)

    if existing_zotero_item:
        zotero_key = existing_zotero_item["key"]
        actions.append(PlanAction(
            category="沿用",
            description=f"Zotero 已有此書目 (Key: {zotero_key})",
            target="Zotero",
            details={"key": zotero_key},
        ))

        # Check existing attachments
        attachments = zotero_client.find_existing_attachments(zotero_key)
        att_filenames = [a.get("data", {}).get("filename", "") for a in attachments]

        if pdf:
            if pdf.filename in att_filenames:
                actions.append(PlanAction(
                    category="沿用",
                    description=f"Zotero 已掛載相同檔名附件 ({pdf.filename})",
                    target="Attachment",
                ))
            else:
                actions.append(PlanAction(
                    category="新增",
                    description=f"為既有書目補掛附件 ({pdf.filename})",
                    target="Attachment",
                    details={"file": str(pdf.path)},
                ))

        # Check OB backlink
        has_ob_link = any("obsidian://" in a.get("data", {}).get("url", "") for a in attachments)
        if note and not has_ob_link:
            actions.append(PlanAction(
                category="新增",
                description=f"為 Zotero 書目建立返回 OB 筆記之連結",
                target="Zotero",
            ))
        elif has_ob_link:
            actions.append(PlanAction(
                category="沿用",
                description=f"Zotero 已包含 OB 筆記回連",
                target="Zotero",
            ))

    else:
        if zot_status.get("web_api") or zot_status.get("local_api"):
            actions.append(PlanAction(
                category="新增",
                description=f"在 Zotero 建立新書目 ({meta.title[:45]}...)",
                target="Zotero",
            ))
            if pdf:
                actions.append(PlanAction(
                    category="新增",
                    description=f"上傳 PDF 附件 ({pdf.filename}) 至 Zotero",
                    target="Attachment",
                ))
            if note:
                actions.append(PlanAction(
                    category="新增",
                    description=f"為新書目建立返回 OB 筆記之連結",
                    target="Zotero",
                ))
        else:
            warnings.append("Zotero 目前處於離線狀態；Zotero 書目與附件將標記為待處理 (Pending)。")
            actions.append(PlanAction(
                category="待確認",
                description="Zotero 離線：延後建立書目與附件，先完成 OB 原地補登",
                target="Zotero",
            ))

    # Step 4: Obsidian Note Planning
    if note:
        planned_ob_updates = {}
        if meta.citekey and note.citekey != meta.citekey:
            planned_ob_updates["citekey"] = meta.citekey
        if zotero_key:
            expected_zot_link = f"zotero://select/library/items/{zotero_key}"
            if note.zotero_link != expected_zot_link:
                planned_ob_updates["zotero"] = expected_zot_link
        if primary_doi and note_doi != primary_doi:
            planned_ob_updates["doi"] = primary_doi
        if primary_pmid and note_pmid != primary_pmid:
            planned_ob_updates["pmid"] = primary_pmid
        if meta.authors and not note.existing_frontmatter.get("authors"):
            planned_ob_updates["authors"] = meta.authors
        if meta.journal and not note.existing_frontmatter.get("journal"):
            planned_ob_updates["journal"] = meta.journal
        if meta.year and not note.existing_frontmatter.get("year"):
            planned_ob_updates["year"] = meta.year

        if pdf and "pdf" not in note.existing_frontmatter:
            # Pair PDF in-place without moving
            try:
                vault_root = Path(__file__).parent.parent.parent
                rel_pdf = pdf.path.relative_to(vault_root).as_posix()
                planned_ob_updates["pdf"] = rel_pdf
            except Exception:
                planned_ob_updates["pdf"] = str(pdf.path)

        if planned_ob_updates:
            actions.append(PlanAction(
                category="新增",
                description=f"原地補充筆記欄位: {', '.join(planned_ob_updates.keys())}",
                target="OB",
                details=planned_ob_updates,
            ))
        else:
            actions.append(PlanAction(
                category="沿用",
                description="OB 手寫筆記之必要欄位皆已具備，內文保持原樣",
                target="OB",
            ))

    if status == MatchStatus.CONFLICT:
        pass
    elif status == MatchStatus.PENDING_CONFIRMATION:
        pass
    elif not warnings and existing_zotero_item and note and not any(a.category == "新增" for a in actions):
        status = MatchStatus.REUSE
    else:
        status = MatchStatus.NEW


    return IngestPlan(
        match_status=status,
        metadata=meta,
        pdf=pdf,
        note=note,
        zotero_key=zotero_key,
        actions=actions,
        warnings=warnings,
    )
