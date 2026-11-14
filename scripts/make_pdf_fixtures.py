#!/usr/bin/env python3
"""Generate PDF test documents in tests/fixtures/.

office.pdf       — LibreOffice export of sample.docx (embedded TrueType subsets + ToUnicode, CJK fallback font),
                   then enriched like real corporate PDFs: Office-style MSIP_Label_* Info keys, XMP with the
                   label, a "Confidential" stamp, a FreeText comment, bookmarks and an attachment.
incremental.pdf  — a page whose content was replaced by an incremental update: the old content stream with
                   "CONFIDENTIAL" is still physically in the file (orphan) — must not survive cleaning.
reportlab.pdf    — two pages, standard (non-embedded) Helvetica with WinAnsi, a rotated diagonal watermark,
                   header/footer labels, text drawn glyph-by-glyph, a CJK CID font (MSung-Light, UniCNS-UCS2-H)
                   and the same logo image on both pages.

Requires: LibreOffice (soffice), pypdf, reportlab.   Run: npm run fixtures
"""
import io
import os
import shutil
import subprocess
import tempfile

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import FreeText, Text
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, TextStringObject
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "tests", "fixtures")
GUID = "3f5c2a1e-1111-4a2b-9c3d-0123456789ab"

XMP = f"""<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Q3 Plan - Confidential</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>
<pdfx:MSIP_Label_{GUID}_Enabled>true</pdfx:MSIP_Label_{GUID}_Enabled>
<pdfx:MSIP_Label_{GUID}_Name>Confidential</pdfx:MSIP_Label_{GUID}_Name>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>"""


def office_pdf():
    tmp = tempfile.mkdtemp()
    shutil.copy(os.path.join(OUT, "sample.docx"), os.path.join(tmp, "office.docx"))
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, os.path.join(tmp, "office.docx")], check=True, capture_output=True, timeout=180)
    w = PdfWriter(clone_from=os.path.join(tmp, "office.pdf"))
    w.add_metadata(
        {
            f"/MSIP_Label_{GUID}_Enabled": "true",
            f"/MSIP_Label_{GUID}_Name": "Confidential",
            f"/MSIP_Label_{GUID}_SiteId": "8a9b0c1d-2222-4e5f-a6b7-0123456789cd",
            "/Company": "ACME Corp",
            "/Classification": "Restricted",
        }
    )
    xmp = DecodedStreamObject()
    xmp.set_data(XMP.encode("utf-8"))
    xmp[NameObject("/Type")] = NameObject("/Metadata")
    xmp[NameObject("/Subtype")] = NameObject("/XML")
    w._root_object[NameObject("/Metadata")] = w._add_object(xmp)

    stamp = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Stamp"),
            NameObject("/Name"): NameObject("/Confidential"),
            NameObject("/Rect"): ArrayObject([FloatObject(400), FloatObject(700), FloatObject(560), FloatObject(760)]),
            NameObject("/F"): FloatObject(4),
        }
    )
    w.add_annotation(page_number=0, annotation=stamp)
    w.add_annotation(page_number=0, annotation=FreeText(text="Internal only - do not forward", rect=(50, 50, 300, 90)))
    w.add_annotation(page_number=0, annotation=Text(text="Looks fine to me", rect=(300, 300, 320, 320)))
    w.add_outline_item("Introduction", 0)
    w.add_outline_item("Confidential appendix", 0)
    w.add_attachment("original.docx", b"pretend this is the original document")
    w.write(os.path.join(OUT, "office.pdf"))
    shutil.rmtree(tmp)


def incremental_pdf():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 24)
    c.drawString(72, 750, "CONFIDENTIAL draft")
    c.save()
    base = os.path.join(OUT, "incremental.pdf")
    open(base, "wb").write(buf.getvalue())
    # incremental update: replace the page content, leaving the old stream physically in the file
    w = PdfWriter(base, incremental=True)
    page = w.pages[0]
    new = DecodedStreamObject()
    new.set_data(b"BT /F1 24 Tf 72 750 Td (Public version) Tj ET")
    page[NameObject("/Contents")] = w._add_object(new)
    w.add_metadata({"/Title": "Public version"})
    with open(base, "wb") as f:
        w.write(f)


def reportlab_pdf():
    pdfmetrics.registerFont(UnicodeCIDFont("MSung-Light"))
    logo = os.path.join(OUT, "logo.png")  # written by make_fixtures.py
    c = canvas.Canvas(os.path.join(OUT, "reportlab.pdf"), pagesize=A4)
    c.setTitle("Plan")
    c.setAuthor("Jane Doe")
    w, h = A4
    for n in (1, 2):
        c.drawImage(logo, 40, h - 70, width=60, height=30)  # same logo, same place, every page
        c.setFont("Helvetica", 9)
        c.drawString(110, h - 55, "ACME Corp - Company Confidential")
        c.drawRightString(w - 40, 30, f"Internal Use Only | Page {n}")
        # rotated diagonal watermark
        c.saveState()
        c.setFont("Helvetica-Bold", 60)
        c.setFillGray(0.85)
        c.translate(w / 2, h / 2)
        c.rotate(45)
        c.drawCentredString(0, 0, "CONFIDENTIAL")
        c.restoreState()
        c.setFont("Helvetica", 12)
        c.drawString(72, 650, "This report is strictly confidential and intended for the board.")
        c.drawString(72, 630, "The Secretary approved the plan.")
        # glyph-by-glyph text: one Tj per character (common in some generators)
        x = 72
        for ch in "Secret":
            c.drawString(x, 610, ch)
            x += c.stringWidth(ch, "Helvetica", 12)
        c.drawString(x + 4, 610, "project codename")
        c.setFont("MSung-Light", 14)
        c.drawString(72, 580, "本報告為公司機密，請勿外傳。")
        c.showPage()
    c.save()




def form_pdf():
    """AcroForm: a text field and a dropdown whose values are labels, plus an unrelated field."""
    c = canvas.Canvas(os.path.join(OUT, "form.pdf"), pagesize=A4)
    c.drawString(72, 760, "Classification:")
    c.acroForm.textfield(name="classification", tooltip="Confidential data classification", value="Confidential", x=180, y=752, width=200, height=20)
    c.acroForm.choice(name="level", value="Internal Use Only", options=["Public", "Internal Use Only", "Secret"], x=180, y=720, width=200, height=20)
    c.acroForm.textfield(name="owner", value="Finance team", x=180, y=690, width=200, height=20)
    c.save()


def tagged_pdf():
    """Tagged (accessible) PDF exported by LibreOffice: the picture's alt text lands in the structure tree /Alt."""
    import docx

    tmp = tempfile.mkdtemp()
    d = docx.Document()
    d.add_paragraph("Quarterly report")
    d.add_picture(os.path.join(OUT, "logo.png"))
    d.inline_shapes[0]._inline.docPr.set("descr", "ACME Confidential logo")
    d.add_paragraph("End of report.")
    src = os.path.join(tmp, "tagged.docx")
    d.save(src)
    opts = 'pdf:writer_pdf_Export:{"UseTaggedPDF":{"type":"boolean","value":"true"}}'
    subprocess.run(["soffice", "--headless", "--convert-to", opts, "--outdir", tmp, src], check=True, capture_output=True, timeout=180)
    shutil.copy(os.path.join(tmp, "tagged.pdf"), os.path.join(OUT, "tagged.pdf"))
    shutil.rmtree(tmp)


def scanned_pdf():
    """A 'searchable scan': the page is one full-page image (with CONFIDENTIAL burnt into the pixels) and an
    invisible OCR text layer (text render mode 3) on top — what scanners / OCR software produce."""
    from PIL import Image, ImageDraw

    img = Image.new("L", (850, 1100), 255)
    dr = ImageDraw.Draw(img)
    dr.rectangle([60, 60, 330, 100], outline=0)
    dr.text((80, 72), "CONFIDENTIAL", fill=0)
    dr.text((80, 200), "Quarterly report for the board", fill=0)
    path = os.path.join(tempfile.mkdtemp(), "scan.png")
    img.save(path)
    c = canvas.Canvas(os.path.join(OUT, "scanned.pdf"), pagesize=A4)
    w, h = A4
    c.drawImage(path, 0, 0, width=w, height=h)
    t = c.beginText(57, h - 60)
    t.setTextRenderMode(3)  # invisible: OCR layer
    t.setFont("Helvetica", 12)
    t.textLine("CONFIDENTIAL")
    t.moveCursor(0, 80)
    t.textLine("Quarterly report for the board")
    c.drawText(t)
    c.save()


def encrypted_pdf():
    """Owner-password-only PDF (opens without a password, editing restricted) — common in corporate exports."""
    w = PdfWriter(clone_from=os.path.join(OUT, "incremental.pdf"))
    w.encrypt(user_password="", owner_password="owner-secret", algorithm="AES-128")
    w.write(os.path.join(OUT, "encrypted.pdf"))


if __name__ == "__main__":
    office_pdf()
    incremental_pdf()
    reportlab_pdf()
    encrypted_pdf()
    form_pdf()
    tagged_pdf()
    scanned_pdf()
    for name in ("office.pdf", "incremental.pdf", "reportlab.pdf", "encrypted.pdf", "form.pdf", "tagged.pdf", "scanned.pdf"):
        r = PdfReader(os.path.join(OUT, name))
        print(name, len(r.pages), "pages")
