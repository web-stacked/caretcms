"""Generate the standardized HTML5 character-reference table using Python stdlib."""
from pathlib import Path
import html.entities
import json

root = Path(__file__).resolve().parent.parent
target = root / "packages/core/src/runtime/html-entities.ts"
target.write_text(
    "// Generated HTML named character references (HTML5). No runtime dependency.\n"
    "// Regenerate with scripts/generate-html-entities.py.\n"
    "export const HTML_ENTITIES: Readonly<Record<string, string>> = "
    + json.dumps(html.entities.html5, ensure_ascii=True, sort_keys=True, indent=2)
    + ";\n"
)
