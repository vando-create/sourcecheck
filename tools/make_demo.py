"""Generate a fictional demo sub doc (PDF) + a smart-form JSON with seeded bugs.

Everything here is invented ("Northwind Credit Fund I"), so the demo can live in a public repo.
Seeded issues the checker should find:
  1. Q2 Yes/No options mapped to the opposite PDF boxes            -> Swapped mapping
  2. Accredited-investor paragraph says "Regulation S" (PDF: "Regulation D") -> Text differs
  3. Income option says $300,000 (PDF: $200,000)                   -> Text differs
  4. U.S. Person footnote says "Rule 902" (PDF: "Regulation S")      -> Text differs (footnote)
  5. AML cooperation paragraph on page 2 not built in the form      -> Missing in form
  6. A blue helper message that is not in the PDF                   -> Form-only text (info)
  7. "have attached" -> "wish to attach" (acceptable adaptation)     -> Text differs (low)
"""
import json, os
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

OUT = os.path.join(os.path.dirname(__file__), '..', 'demo')
os.makedirs(OUT, exist_ok=True)
W, H = letter
PDF_NAME = 'Northwind Credit Fund I - Subscription Booklet.pdf'
pdf_path = os.path.join(OUT, PDF_NAME)
c = canvas.Canvas(pdf_path, pagesize=letter)
c.setTitle('Northwind Credit Fund I - Subscription Booklet (fictional demo)')

fields = []  # annotation layer
def norm_box(page, x, y_bottom, w, h):
    # Anduin convention: xPos left, yPos = BOTTOM edge measured from the top, all normalized
    return {'page': page, 'xPos': x / W, 'yPos': (H - y_bottom) / H, 'width': w / W, 'height': h / H}

def para(text, x, y, width=W - 144, font='Times-Roman', size=11, leading=14):
    c.setFont(font, size)
    lines = simpleSplit(text, font, size, width)
    for ln in lines:
        c.drawString(x, y, ln); y -= leading
    return y

def checkbox(x, y, size=10):
    c.rect(x, y - 1, size, size, stroke=1, fill=0)
    return (x, y - 1, size, size)

# ------------------------------- page 1 -------------------------------
page = 1
c.setFont('Times-Bold', 14); c.drawCentredString(W / 2, H - 72, 'NORTHWIND CREDIT FUND I, L.P.')
c.setFont('Times-Bold', 12); c.drawCentredString(W / 2, H - 92, 'INVESTOR QUESTIONNAIRE')
y = H - 130
c.setFont('Times-Roman', 11); c.drawString(72, y, '1.  Name of Investor:'); c.line(185, y - 2, 470, y - 2)
fields.append({'key': 'investor_name', 'widgetType': 'TextBox', 'position': norm_box(page, 185, y - 2, 285, 16), 'radioOptions': []})
y -= 36
c.drawString(72, y, '2.  Is the Investor a “U.S. Person”?')
c.setFont('Times-Roman', 7); c.drawString(72 + c.stringWidth('2.  Is the Investor a “U.S. Person”?', 'Times-Roman', 11) + 1, y + 5, '1'); c.setFont('Times-Roman', 11)
bx1 = checkbox(320, y); c.drawString(334, y, 'Yes')
bx2 = checkbox(380, y); c.drawString(394, y, 'No')
fields.append({'key': 'usperson', 'widgetType': 'Radio', 'position': norm_box(page, bx1[0], bx1[1], 10, 10),
               'radioOptions': [['yes_usperson', norm_box(page, bx1[0], bx1[1], 10, 10)], ['no_usperson', norm_box(page, bx2[0], bx2[1], 10, 10)]]})
y -= 34
y = para('3.  The Investor represents and warrants that it is an “accredited investor” within the meaning of Regulation D under the Securities Act and has checked the box or boxes below for each statement that applies to it.', 72, y)
y -= 10
opts = [('networth', 'The Investor’s net worth, alone or together with a spouse, exceeds $1,000,000, excluding the value of the primary residence.'),
        ('income', 'The Investor had individual income in excess of $200,000 in each of the two most recent years and reasonably expects the same level of income in the current year.'),
        ('licensed', 'The Investor holds in good standing a Series 7, Series 65 or Series 82 license.')]
for key, text in opts:
    bx = checkbox(90, y)
    y = para(text, 108, y, width=W - 180) - 6
    fields.append({'key': key + '_group', 'widgetType': 'MultipleCheckbox', 'position': norm_box(page, bx[0], bx[1], 10, 10), 'radioOptions': [],
                   'widget': {'ui:multipleOption': {'options': [[key, {'pdfMappings': [key]}]]}}})
y -= 8
bx = checkbox(72, y); y = para('Please check this box if you have attached a separate sheet listing additional authorized signatories.', 90, y, width=W - 162) - 10
fields.append({'key': 'attach_group', 'widgetType': 'MultipleCheckbox', 'position': norm_box(page, bx[0], bx[1], 10, 10), 'radioOptions': [],
               'widget': {'ui:multipleOption': {'options': [['attach', {'pdfMappings': ['attach']}]]}}})
c.line(72, 110, 200, 110)
c.setFont('Times-Roman', 9)
c.drawString(72, 98, '1')
para('“U.S. Person” has the meaning given in Regulation S under the Securities Act and includes any natural person resident in the United States.', 80, 98, size=9, leading=11, width=W - 152)
c.setFont('Times-Roman', 10); c.drawCentredString(W / 2, 40, 'Q-1')
c.showPage()

# ------------------------------- page 2 -------------------------------
page = 2
y = H - 80
c.setFont('Times-Roman', 11)
c.drawString(72, y, '4.  Source of Wealth (check all that apply):'); y -= 22
for key, label in [('salary', 'Salary / bonus'), ('investments', 'Sale of investments'), ('inheritance', 'Inheritance / Gift')]:
    bx = checkbox(90, y); c.drawString(106, y, label); y -= 18
    fields.append({'key': key + '_group', 'widgetType': 'MultipleCheckbox', 'position': norm_box(page, bx[0], bx[1], 10, 10), 'radioOptions': [],
                   'widget': {'ui:multipleOption': {'options': [[key, {'pdfMappings': [key]}]]}}})
y -= 16
y = para('5.  The Investor agrees to provide such additional information as the General Partner may reasonably request in order to comply with applicable anti-money laundering and sanctions laws.', 72, y) - 14
y = para('6.  The Investor acknowledges that the General Partner may reject this subscription in whole or in part in its sole discretion.', 72, y) - 30
c.drawString(72, y, 'Signature: ______________________________          Date: ______________')
fields.append({'key': 'sig_investor', 'widgetType': 'Signature', 'position': norm_box(page, 130, y - 2, 170, 18), 'radioOptions': []})
c.setFont('Times-Roman', 10); c.drawCentredString(W / 2, 40, 'Q-2')
c.showPage(); c.save()

# ------------------------------- form JSON -------------------------------
def fn(text):  # Anduin footnote encoding
    return f'<span data-title="&lt;p&gt;{text}&lt;/p&gt;">FOOT_NOTE_HERE</span>'

ui = {
    'page1': {'ui:widget': 'Page'},
    'header1': {'ui:widget': 'Header', 'ui:heading': 'INVESTOR QUESTIONNAIRE', 'ui:subtitle': 'Northwind Credit Fund I, L.P.'},
    'investor_name': {'ui:widget': 'TextBox', 'ui:formattedText': '<p>1. Name of Investor <span style="color: rgb(219, 55, 55);">*</span></p>', 'ui:pdfMapping': ['investor_name']},
    'usperson': {'ui:widget': 'Radio', 'ui:formattedText': '<p>2. Is the Investor a “U.S. Person”' + fn('“U.S. Person” has the meaning given in Rule 902 under the Securities Act and includes any natural person resident in the United States.') + '?</p>',
                 'ui:pdfMapping': ['usperson'],
                 # SEEDED BUG: options point at the opposite PDF boxes
                 'ui:multipleOption': {'options': [['yes', {'pdfMappings': ['no_usperson'], 'formattedText': 'Yes'}], ['no', {'pdfMappings': ['yes_usperson'], 'formattedText': 'No'}]]}},
    'accredited_intro': {'ui:widget': 'Paragraph', 'ui:formattedText': '<p>3. The Investor represents and warrants that it is an “accredited investor” within the meaning of Regulation S under the Securities Act and has checked the box or boxes below for each statement that applies to it.</p>'},
    'accredited': {'ui:widget': 'MultipleCheckbox', 'ui:formattedText': '<p>Please check all that apply:</p>',
                   'ui:multipleOption': {'options': [
                       ['networth', {'pdfMappings': ['networth'], 'formattedText': 'The Investor’s net worth, alone or together with a spouse, exceeds $1,000,000, excluding the value of the primary residence.'}],
                       ['income', {'pdfMappings': ['income'], 'formattedText': 'The Investor had individual income in excess of $300,000 in each of the two most recent years and reasonably expects the same level of income in the current year.'}],
                       ['licensed', {'pdfMappings': ['licensed'], 'formattedText': 'The Investor holds in good standing a Series 7, Series 65 or Series 82 license.'}]]}},
    'attach': {'ui:widget': 'MultipleCheckbox', 'ui:multipleOption': {'options': [['attach', {'pdfMappings': ['attach'], 'formattedText': 'Check this box if you wish to attach a separate sheet listing additional authorized signatories.'}]]}},
    'page2': {'ui:widget': 'Page'},
    'helper': {'ui:widget': 'Paragraph', 'ui:wellType': 'Info', 'ui:formattedText': '<p>Please answer every question on this page before continuing to the signature step.</p>'},
    'sourceofwealth': {'ui:widget': 'MultipleCheckbox', 'ui:formattedText': '<p>4. Source of Wealth (check all that apply)</p>',
                       'ui:multipleOption': {'options': [['salary', {'pdfMappings': ['salary'], 'formattedText': 'Salary / bonus'}], ['investments', {'pdfMappings': ['investments'], 'formattedText': 'Sale of investments'}], ['inheritance', {'pdfMappings': ['inheritance'], 'formattedText': 'Inheritance / Gift'}]]}},
    # SEEDED BUG: paragraph 5 (AML cooperation) is not built
    'reject': {'ui:widget': 'Paragraph', 'ui:formattedText': '<p>6. The Investor acknowledges that the General Partner may reject this subscription in whole or in part in its sole discretion.</p>'},
    'signature': {'ui:widget': 'Signature', 'ui:signature': [{'mapping': 'sig_investor', 'signatureType': 'Signature'}]},
}
schema = {'type': 'object', 'properties': [
    {'name': 'page1', 'type': 'object', 'title': 'Investor Questionnaire', 'properties': [
        {'name': 'header1', 'type': 'null'}, {'name': 'investor_name', 'type': 'string'}, {'name': 'usperson', 'type': 'string'},
        {'name': 'accredited_intro', 'type': 'null'}, {'name': 'accredited', 'type': 'array'}, {'name': 'attach', 'type': 'array'}]},
    {'name': 'page2', 'type': 'object', 'title': 'Source of Wealth & Signature', 'properties': [
        {'name': 'helper', 'type': 'null'}, {'name': 'sourceofwealth', 'type': 'array'}, {'name': 'reject', 'type': 'null'}, {'name': 'signature', 'type': 'null'}]},
]}
form = {'form': {'namespaceFormSchemaMap': {'main': {'schema': schema, 'uiSchema': ui}}, 'rules': [], 'defaultNamespace': 'main'},
        'uploadedPdf': [['demo.fil000001', {'name': PDF_NAME, 'fields': fields}]], 'embeddedPdf': []}
with open(os.path.join(OUT, 'northwind-demo-form.json'), 'w') as f:
    json.dump(form, f, indent=1, ensure_ascii=False)
import base64
with open(pdf_path, 'rb') as fh:
    b64 = base64.b64encode(fh.read()).decode()
with open(os.path.join(OUT, 'northwind-pdf.js'), 'w') as fh:
    fh.write("// Fictional demo sub doc, base64-encoded (generated by tools/make_demo.py)\n"
             f"export const PDF_NAME = '{PDF_NAME}';\nexport const PDF_BASE64 =\n  '{b64}';\n")
os.remove(pdf_path)  # the app and tests use the base64 module
print('wrote', OUT)
