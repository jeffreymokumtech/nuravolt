# Resource PDFs

This directory contains generated PDF files for whitepapers and checklists.

## Required Files

Generate these PDFs from HTML source files in `../content/`:

### Whitepapers
- `irradiation-data-quality.pdf` (5 pages)
- `inverter-failures-detection.pdf` (4 pages)
- `bess-thermal-runaway.pdf` (6 pages)

### Checklists
- `pv-data-checklist.pdf` (1 page)
- `inverter-checklist.pdf` (1 page)
- `bess-checklist.pdf` (1 page)

## How to Generate

### Option 1: Automated (Recommended)
```bash
npm run generate-pdfs
```

### Option 2: Manual
1. Open each HTML file from `../content/` in a browser
2. Use Print → Save as PDF
3. Save to this directory with matching filename

## File Sizes

Typical file sizes:
- Whitepapers: 200-500 KB
- Checklists: 100-200 KB

## Notes

- PDFs are served directly from this directory via `/resources/pdfs/{slug}.pdf`
- Keep filenames matching the resource slug exactly
- Use print-optimized settings (A4, 2cm margins, print backgrounds enabled)
