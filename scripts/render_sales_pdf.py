#!/usr/bin/env python3
"""Render a sales-asset Markdown file to PDF with NuraVolt house styling.

The shipped PDFs under ``sales-assets/`` were previously produced by hand in
headless Chrome, which meant the ``.md`` and the ``.pdf`` could drift -- and did:
``CAPABILITIES_OVERVIEW.pdf`` kept circulating with a predictive-model table that
had already been corrected in the Markdown. This script makes the PDF a build
artifact of the Markdown so that can't happen again.

Design tokens match ``sales-assets/nuravolt-pricing.html``.

Usage:
    python scripts/render_sales_pdf.py sales-assets/CAPABILITIES_OVERVIEW.md
    python scripts/render_sales_pdf.py sales-assets/CAPABILITIES_OVERVIEW.md --keep-html
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from markdown_it import MarkdownIt

CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
)

CSS = """
@page { size: A4; margin: 14mm 15mm; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:root {
  --blue:#006FEE; --blue-dark:#001730; --sky:#E6F1FF; --amber:#F59E0B;
  --ink:#001730; --muted:#5b6b7d; --line:#e5e7eb; --bg:#f7f9fc;
}
body {
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--ink); font-size:10.4px; line-height:1.6;
}
h1 { font-size:23px; color:var(--blue-dark); border-bottom:3px solid var(--blue);
     padding-bottom:8px; margin-bottom:12px; }
h2 { font-size:15px; color:var(--blue); margin-top:20px; margin-bottom:7px;
     text-transform:uppercase; letter-spacing:.6px; }
h3 { font-size:12.2px; color:var(--blue-dark); margin-top:14px; margin-bottom:5px; }
p  { margin:6px 0; }
ul, ol { margin:6px 0 6px 18px; }
li { margin:3px 0; }
strong { color:var(--blue-dark); }
em { color:var(--muted); }
hr { border:none; border-top:1px solid var(--line); margin:16px 0; }
table { width:100%; border-collapse:collapse; margin:8px 0; font-size:9.8px;
        page-break-inside:avoid; }
th, td { text-align:left; padding:5px 9px; border-bottom:1px solid var(--line);
         vertical-align:top; }
thead th { font-size:8.4px; text-transform:uppercase; letter-spacing:.5px;
           color:var(--blue); border-bottom:2px solid var(--blue); font-weight:700; }
tbody td:first-child { font-weight:700; color:var(--blue-dark); }
blockquote { background:var(--bg); border-left:4px solid var(--blue); border-radius:0 6px 6px 0;
             padding:8px 12px; margin:8px 0; color:var(--muted); font-size:9.8px;
             page-break-inside:avoid; }
blockquote p { margin:4px 0; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:9.4px;
       background:var(--sky); padding:1px 4px; border-radius:3px; }
h2, h3 { page-break-after:avoid; }
"""

HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>{title}</title>
<style>{css}</style></head><body>{body}</body></html>
"""


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
        found = shutil.which(c)
        if found:
            return found
    raise SystemExit(
        "No Chrome/Chromium found. Install one, or pass --chrome /path/to/binary."
    )


#: HTML comments carry the source annotations that ``check_overview_numbers.py``
#: resolves. They are authoring metadata, never content.
COMMENT = re.compile(r"<!--.*?-->", re.S)


def render(md_path: Path, out_path: Path, chrome: str, keep_html: bool) -> None:
    md = MarkdownIt("commonmark", {"html": False}).enable("table").enable("strikethrough")
    # Strip comments BEFORE rendering. markdown-it with html=False *escapes* raw
    # HTML rather than dropping it, so an un-stripped `<!-- ACCURACY-OK: ... -->`
    # prints verbatim in the PDF. That shipped once, in a battery one-pager whose
    # every table row was preceded by its own provenance comment in 9pt grey.
    body = md.render(COMMENT.sub("", md_path.read_text()))
    title = md_path.stem.replace("_", " ").title()
    html = HTML.format(title=title, css=CSS, body=body)

    tmp_dir = Path(tempfile.mkdtemp(prefix="sales-pdf-"))
    html_path = tmp_dir / (md_path.stem + ".html")
    html_path.write_text(html)

    subprocess.run(
        [
            chrome,
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            f"--print-to-pdf={out_path}",
            html_path.as_uri(),
        ],
        check=True,
        capture_output=True,
    )

    if keep_html:
        kept = md_path.with_suffix(".html")
        shutil.copy(html_path, kept)
        print(f"kept HTML -> {kept}")
    shutil.rmtree(tmp_dir, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("markdown", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=None)
    ap.add_argument("--chrome", default=None)
    ap.add_argument("--keep-html", action="store_true")
    args = ap.parse_args()

    if not args.markdown.exists():
        raise SystemExit(f"not found: {args.markdown}")
    out = args.out or args.markdown.with_suffix(".pdf")
    render(args.markdown, out.resolve(), args.chrome or find_chrome(), args.keep_html)
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
