#!/usr/bin/env python3
"""Sprint 6: verify a court-packet PDF structurally and against the .json it was rendered from.
usage: python3 scripts/sprint6-verify-pdf.py packet.pdf packet.json"""
import json, subprocess, sys
pdf_path, json_path = sys.argv[1], sys.argv[2]
raw = open(pdf_path, 'rb').read(); data = json.load(open(json_path))
fails = []
def check(ok, what):
    print(('  PASS ' if ok else '  FAIL ') + what)
    if not ok: fails.append(what)
check(raw[:5] == b'%PDF-', f'header bytes {raw[:8]!r}')
check(raw.rstrip().endswith(b'%%EOF'), 'trailer ends with %%EOF')
check(b'startxref' in raw[-200:], 'startxref present near end')
check(len(raw) > 3000, f'size {len(raw)} bytes')
from pypdf import PdfReader
r = PdfReader(pdf_path, strict=True)
check(len(r.pages) >= 1, f'pypdf strict parse OK, {len(r.pages)} page(s), title={r.metadata.title!r}')
info = subprocess.run(['pdfinfo', pdf_path], capture_output=True, text=True)
check(info.returncode == 0 and not info.stderr.strip(), 'pdfinfo: no errors' + (f' ({info.stderr.strip()})' if info.stderr.strip() else ''))
txt = subprocess.run(['pdftotext', '-layout', pdf_path, '-'], capture_output=True, text=True).stdout
flat = ' '.join(txt.split())
money = lambda c: '$' + f'{c/100:,.2f}'
facts = [data['property']['unit'], data['tenant']['name'], money(data['rent_period']['amount_due_cents']), data['rent_period']['due_date'],
         data['generated_at'][:19].replace('T', ' ') + ' UTC', 'not legal advice', 'Balance and status: ' + data['summary']['status'],
         data['integrity']['sha256']]
facts += data['summary']['lines'][:2]
for p in data['payments']:
    facts += [x for x in (p['paypal_order_id'], p['paypal_capture_id'], p['webhook_event_id']) if x]
    facts += [f"{money(p['amount_cents'])} / {money(p['fee_cents'])} / {money(p['net_cents'])}"]
    if p['webhook_confirmed']: facts.append('signature verification with PayPal: ' + p['signature_verification'])
for e in data['events']:
    facts.append(e['at'][:19].replace('T', ' '))
for f in facts:
    check(' '.join(str(f).split()) in flat, f'text contains {str(f)[:90]!r}')
# Every ledger row's full details text, in content-stream order (-raw keeps each table cell contiguous).
rawtxt = ' '.join(subprocess.run(['pdftotext', '-raw', pdf_path, '-'], capture_output=True, text=True).stdout.split())
squash = lambda x: ''.join(x.split())   # pdftotext drops the space at some wrapped line ends, so compare without whitespace
for e in data['events']:
    check(squash(e['summary']) in squash(rawtxt), f"ledger row #{e['id']} {e['kind']} full text ({len(e['summary'])} chars, whitespace-insensitive)")
    facts.append(e['id'])
print(f'{len(facts)} facts checked, {len(fails)} failed; {len(data["events"])} ledger rows, {len(data["payments"])} payments')
sys.exit(1 if fails else 0)
