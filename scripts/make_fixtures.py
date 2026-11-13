#!/usr/bin/env python3
"""Generate realistic test documents in tests/fixtures/.

Each fixture deliberately contains labels in the places real documents hide them:
split Word runs, headers/footers, VML watermarks, text boxes, DOCPROPERTY fields, tracked deletions, comments,
Excel header/footer codes, formula literals, pivot/chart caches, PowerPoint masters/notes, embedded chart workbooks,
core/app/custom properties, Microsoft Purview MSIP_Label_* properties and docMetadata/LabelInfo.xml.

Requires: python-docx, openpyxl, python-pptx.   Run: npm run fixtures
"""
import io
import os
import re
import zipfile

import docx
import openpyxl
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
from openpyxl.comments import Comment
from openpyxl.packaging.custom import StringProperty
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
os.makedirs(OUT, exist_ok=True)

LABEL_GUID = "3f5c2a1e-1111-4a2b-9c3d-0123456789ab"
SITE_GUID = "8a9b0c1d-2222-4e5f-a6b7-0123456789cd"
MSIP = [
    (f"MSIP_Label_{LABEL_GUID}_Enabled", "true"),
    (f"MSIP_Label_{LABEL_GUID}_SetDate", "2024-05-01T08:00:00Z"),
    (f"MSIP_Label_{LABEL_GUID}_Method", "Standard"),
    (f"MSIP_Label_{LABEL_GUID}_Name", "Confidential"),
    (f"MSIP_Label_{LABEL_GUID}_SiteId", SITE_GUID),
    (f"MSIP_Label_{LABEL_GUID}_ActionId", "aaaaaaaa-3333-4bbb-8ccc-0123456789ef"),
    (f"MSIP_Label_{LABEL_GUID}_ContentBits", "3"),
]
CUSTOM_EXTRA = [("Classification", "Restricted"), ("Project", "Apollo")]
LABELINFO = (
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>'
    '<clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata">'
    f'<clbl:label id="{{{LABEL_GUID}}}" enabled="1" method="Standard" siteId="{{{SITE_GUID}}}" removed="0"/>'
    "</clbl:labelList>"
)


def custom_xml(props):
    items = "".join(
        f'<property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="{i + 2}" name="{n}"><vt:lpwstr>{v}</vt:lpwstr></property>'
        for i, (n, v) in enumerate(props)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' + items + "</Properties>"
    )


def patch_zip(data, *, custom=None, labelinfo=False, company=None, replace=None):
    """Add custom.xml / LabelInfo.xml / Company to an OOXML package, fixing [Content_Types].xml and _rels/.rels."""
    zin = zipfile.ZipFile(io.BytesIO(data))
    files = {i.filename: zin.read(i.filename) for i in zin.infolist()}
    order = [i.filename for i in zin.infolist()]
    ct = files["[Content_Types].xml"].decode()
    rels = files["_rels/.rels"].decode()

    def add_part(path, content, ctype, reltype, rid):
        nonlocal ct, rels
        if path not in files:
            order.append(path)
        files[path] = content.encode() if isinstance(content, str) else content
        if f'PartName="/{path}"' not in ct:
            ct = ct.replace("</Types>", f'<Override PartName="/{path}" ContentType="{ctype}"/></Types>')
        if f'Target="{path}"' not in rels:
            rels = rels.replace("</Relationships>", f'<Relationship Id="{rid}" Type="{reltype}" Target="{path}"/></Relationships>')

    if custom is not None:
        add_part(
            "docProps/custom.xml",
            custom_xml(custom),
            "application/vnd.openxmlformats-officedocument.custom-properties+xml",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties",
            "rIdCustom",
        )
    if labelinfo:
        add_part(
            "docMetadata/LabelInfo.xml",
            LABELINFO,
            "application/vnd.ms-office.classificationlabels+xml",
            "http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels",
            "rIdLabel",
        )
    if company and "docProps/app.xml" in files:
        app = files["docProps/app.xml"].decode()
        if "<Company>" in app:
            app = re.sub(r"<Company>.*?</Company>", f"<Company>{company}</Company>", app)
        elif "<Company/>" in app:
            app = app.replace("<Company/>", f"<Company>{company}</Company>")
        else:
            app = app.replace("</Properties>", f"<Company>{company}</Company></Properties>")
        files["docProps/app.xml"] = app.encode()
    for path, fn in (replace or {}).items():
        files[path] = fn(files[path].decode()).encode()
    files["[Content_Types].xml"] = ct.encode()
    files["_rels/.rels"] = rels.encode()

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in order:
            info = zipfile.ZipInfo(name, date_time=(2024, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, files[name])
    return out.getvalue()


def save(doc_or_wb):
    buf = io.BytesIO()
    doc_or_wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------------------------- docx
def make_docx():
    d = docx.Document()
    cp = d.core_properties
    cp.title = "Q3 Plan - Confidential"
    cp.author = "Jane Doe"
    cp.last_modified_by = "John Roe"
    cp.keywords = "secret; finance"
    cp.subject = "Quarterly plan"

    sec = d.sections[0]
    # header: label split across runs (as Word does after spell-check)
    hp = sec.header.paragraphs[0]
    hp.add_run("ACME ")
    hp.add_run("Confi")
    hp.add_run("dential")
    # VML WordArt watermark (what Design → Watermark → CONFIDENTIAL produces)
    wm = parse_xml(
        f'<w:r {nsdecls("w")} xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">'
        '<w:pict><v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" path="m@7,l@8,m@5,21600l@6,21600e">'
        '<v:textpath on="t" fitshape="t"/></v:shapetype>'
        '<v:shape id="PowerPlusWaterMarkObject1" o:spid="_x0000_s2049" type="#_x0000_t136" '
        'style="position:absolute;margin-left:0;margin-top:0;width:527.85pt;height:131.95pt;rotation:315;z-index:-251657216" '
        'o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/>'
        '<v:textpath style="font-family:&quot;Calibri&quot;;font-size:1pt" string="CONFIDENTIAL"/></v:shape></w:pict></w:r>'
    )
    hp._p.append(wm)

    # footer: DOCPROPERTY field whose cached result is the label, plus plain label text
    fp = sec.footer.paragraphs[0]
    fp._p.append(
        parse_xml(
            f'<w:fldSimple {nsdecls("w")} w:instr=" DOCPROPERTY Classification \\* MERGEFORMAT ">'
            "<w:r><w:t>Restricted</w:t></w:r></w:fldSimple>"
        )
    )
    fp.add_run(" | Internal Use Only | Page ")
    # complex field: PAGE (no label) — must survive untouched
    for xml in (
        '<w:r {ns}><w:fldChar w:fldCharType="begin"/></w:r>',
        '<w:r {ns}><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>',
        '<w:r {ns}><w:fldChar w:fldCharType="separate"/></w:r>',
        '<w:r {ns}><w:t>1</w:t></w:r>',
        '<w:r {ns}><w:fldChar w:fldCharType="end"/></w:r>',
    ):
        fp._p.append(parse_xml(xml.format(ns=nsdecls("w"))))

    d.add_paragraph("STRICTLY CONFIDENTIAL")
    d.add_paragraph("This document contains confidential information about the plan.")
    d.add_paragraph("The Secretary approved the budget.")
    d.add_paragraph("本文件為公司機密文件，請勿外傳。")
    # complex DOCVARIABLE-like field whose result contains a label (must be unlinked when cut)
    p = d.add_paragraph("Status: ")
    for xml in (
        '<w:r {ns}><w:fldChar w:fldCharType="begin"/></w:r>',
        '<w:r {ns}><w:instrText xml:space="preserve"> DOCPROPERTY Status </w:instrText></w:r>',
        '<w:r {ns}><w:fldChar w:fldCharType="separate"/></w:r>',
        '<w:r {ns}><w:t>Top Secret</w:t></w:r>',
        '<w:r {ns}><w:fldChar w:fldCharType="end"/></w:r>',
    ):
        p._p.append(parse_xml(xml.format(ns=nsdecls("w"))))
    # tracked deletion that still lives in the file
    p = d.add_paragraph("Draft ")
    p._p.append(
        parse_xml(
            f'<w:del {nsdecls("w")} w:id="1" w:author="Jane Doe" w:date="2024-01-01T00:00:00Z">'
            '<w:r><w:delText xml:space="preserve">Sensitive </w:delText></w:r></w:del>'
        )
    )
    p.add_run("version")
    # VML text box with a label
    p = d.add_paragraph()
    p._p.append(
        parse_xml(
            f'<w:r {nsdecls("w")} xmlns:v="urn:schemas-microsoft-com:vml"><w:pict><v:shape style="width:200pt;height:40pt">'
            '<v:textbox><w:txbxContent><w:p><w:r><w:t>Internal Only</w:t></w:r></w:p></w:txbxContent></v:textbox>'
            "</v:shape></w:pict></w:r>"
        )
    )
    para = d.add_paragraph("Reviewed by legal.")
    d.add_comment(para.runs, text="Do not distribute outside the team.", author="Reviewer")

    data = patch_zip(save(d), custom=MSIP + CUSTOM_EXTRA, labelinfo=True, company="ACME Corp")
    open(os.path.join(OUT, "sample.docx"), "wb").write(data)


# ---------------------------------------------------------------------------------------------------------------- xlsx
def make_xlsx():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data"
    ws["A1"] = "Confidential"
    ws["A2"] = 42
    ws["B1"] = "Secretary"
    ws["B2"] = "Quarterly numbers - Highly Sensitive"
    ws["C1"] = '=IF(A2>0,"Internal Use Only","OK")'
    ws["D1"] = "Public figures"
    ws["A1"].comment = Comment("Contains sensitive data", "Reviewer")
    ws.oddHeader.center.text = "Strictly Confidential"
    ws.oddHeader.center.font = "Arial,Bold"
    ws.oddFooter.left.text = "Page &P"
    ws.oddFooter.right.text = "R&&D Confidential"  # && = literal ampersand in Excel header codes
    ws2 = wb.create_sheet("Secret Data")
    ws2["A1"] = "Confidential"  # same shared string as Data!A1
    ws2["A2"] = "nothing here"
    wb.properties.creator = "Jane Doe"
    wb.properties.title = "Budget (Internal Use Only)"
    for n, v in MSIP + CUSTOM_EXTRA:
        wb.custom_doc_props.append(StringProperty(name=n, value=v))
    data = patch_zip(save(wb), labelinfo=True, company="ACME Corp")
    open(os.path.join(OUT, "sample.xlsx"), "wb").write(data)


# ---------------------------------------------------------------------------------------------------------------- pptx
def make_pptx():
    prs = Presentation()
    # footer placeholder text on the master (appears on every slide)
    master = prs.slide_master
    for ph in master.placeholders:
        if ph.placeholder_format.type is not None and "FOOTER" in str(ph.placeholder_format.type):
            ph.text_frame.text = "ACME Confidential"
    s1 = prs.slides.add_slide(prs.slide_layouts[0])
    s1.shapes.title.text = "Project Apollo"
    s1.placeholders[1].text = "Strictly Confidential"
    s2 = prs.slides.add_slide(prs.slide_layouts[1])
    s2.shapes.title.text = "Overview"
    s2.placeholders[1].text = "This deck is confidential. Growth is 12%."
    s2.notes_slide.notes_text_frame.text = "Internal only - do not distribute"
    s3 = prs.slides.add_slide(prs.slide_layouts[5])
    s3.shapes.title.text = "Numbers"
    cd = CategoryChartData()
    cd.categories = ["Confidential", "Public"]
    cd.add_series("Revenue", (10, 20))
    gf = s3.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.5), Inches(6), Inches(4), cd)
    gf.chart.has_title = True
    gf.chart.chart_title.text_frame.text = "Secret revenue"
    prs.core_properties.title = "Apollo - Confidential"
    prs.core_properties.author = "Jane Doe"
    data = patch_zip(save(prs), custom=MSIP + CUSTOM_EXTRA, labelinfo=True, company="ACME Corp")
    open(os.path.join(OUT, "sample.pptx"), "wb").write(data)


if __name__ == "__main__":
    make_docx()
    make_xlsx()
    make_pptx()
    print("fixtures written to", os.path.abspath(OUT))
