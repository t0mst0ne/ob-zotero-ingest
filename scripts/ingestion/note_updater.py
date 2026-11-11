"""
In-place Obsidian Note frontmatter updater.
Ensures handwritten notes are the source of truth, updating only essential
fields (citekey, zotero, doi, pmid, etc.) while preserving all existing
content, comments, tags, and structure.
"""

import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


def _format_yaml_value(value: Any) -> str:
    """Format a python value for single-line YAML."""
    if value is None:
        return '""'
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value).strip()
    # Check if value needs quoting (contains ': ', '#', special lead chars, or newlines)
    special_starts = ('[', '{', '@', '%', '*', '&', '?', '|', '>', '-', '#', '!', '"', "'")
    needs_quotes = (
        ': ' in s
        or '#' in s
        or '\n' in s
        or s.startswith(special_starts)
        or s.lower() in ('true', 'false', 'yes', 'no', 'null')
    )
    if needs_quotes:
        escaped = s.replace('"', '\\"')
        return f'"{escaped}"'
    return s



def merge_frontmatter_text(original_content: str, updates: Dict[str, Any]) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """
    Merge updates into the frontmatter of original_content.
    Returns: (updated_content, changes_applied, fields_reused)
    """
    lines = original_content.splitlines()
    changes = {}
    reused = {}

    # Filter out None updates
    clean_updates = {k: v for k, v in updates.items() if v is not None and str(v).strip() != ""}

    if lines and lines[0].strip() == "---":
        end_idx = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                end_idx = i
                break

        if end_idx is not None:
            fm_lines = lines[1:end_idx]
            rest_lines = lines[end_idx:]

            new_fm_lines = []
            seen_keys = set()

            for line in fm_lines:
                m = re.match(r'^([a-zA-Z0-9_-]+)\s*:(.*)$', line)
                if m:
                    key = m.group(1).strip()
                    val_str = m.group(2).strip().strip('"\'')
                    seen_keys.add(key)

                    if key in clean_updates:
                        new_val = clean_updates[key]
                        new_val_str = str(new_val).strip().strip('"\'')
                        if val_str == new_val_str:
                            reused[key] = val_str
                            new_fm_lines.append(line)
                        else:
                            changes[key] = {"old": val_str, "new": new_val_str}
                            new_fm_lines.append(f"{key}: {_format_yaml_value(new_val)}")
                    else:
                        new_fm_lines.append(line)
                else:
                    new_fm_lines.append(line)

            # Append new keys that were not in existing frontmatter
            for k, v in clean_updates.items():
                if k not in seen_keys:
                    changes[k] = {"old": None, "new": str(v)}
                    new_fm_lines.append(f"{k}: {_format_yaml_value(v)}")

            updated_content = "\n".join(["---"] + new_fm_lines + rest_lines)
            if original_content.endswith("\n") and not updated_content.endswith("\n"):
                updated_content += "\n"
            return updated_content, changes, reused

    # Case: Note has no frontmatter
    fm = ["---"]
    for k, v in clean_updates.items():
        changes[k] = {"old": None, "new": str(v)}
        fm.append(f"{k}: {_format_yaml_value(v)}")
    fm.append("---")

    updated_content = "\n".join(fm) + "\n\n" + original_content.lstrip()
    return updated_content, changes, reused


def update_note_frontmatter(
    note_path: Path,
    updates: Dict[str, Any],
    dry_run: bool = False,
) -> Tuple[bool, str, Dict[str, Any], Dict[str, Any]]:
    """
    Update note frontmatter in place.
    Returns: (has_changed, final_content, changes, reused)
    """
    note_path = Path(note_path).resolve()
    if not note_path.exists():
        raise FileNotFoundError(f"Note file not found: {note_path}")

    content = note_path.read_text(encoding="utf-8")
    new_content, changes, reused = merge_frontmatter_text(content, updates)

    has_changed = bool(changes)
    if has_changed and not dry_run:
        note_path.write_text(new_content, encoding="utf-8")

    return has_changed, new_content, changes, reused
