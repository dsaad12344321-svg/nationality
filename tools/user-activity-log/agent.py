from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import traceback
import xml.etree.ElementTree as ET
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

BASE_FOLDER = Path(r"L:\\Common\\Linked Documents\\1-Reservation Data Long Beach")
PORT = 8765
EXTENSIONS = {".msg", ".doc", ".docx", ".pdf"}
MAX_UPLOAD = 25 * 1024 * 1024

def local_name(tag):
    return tag.rsplit("}", 1)[-1].upper()

def child_text(node, wanted):
    for child in node.iter():
        if local_name(child.tag) == wanted:
            return (child.text or "").strip()
    return ""

def parse_date(value):
    value = (value or "").strip()
    match = re.fullmatch(r"(\d{1,2})-(\d{1,2})-(\d{2,4})", value)
    if not match:
        raise ValueError(f"صيغة INS_CHAR_DATE غير معروفة: {value}")
    day, month, year = map(int, match.groups())
    if year < 100:
        year += 2000
    return day, month, year

def extract_guest(description):
    text = re.sub(r"\s+", " ", description or "").strip()
    match = re.search(r"^(.*?)\s+has\s+checked\s+in\b", text, re.I)
    if not match:
        return ""
    return match.group(1).strip(" ,")

def parse_log(xml_bytes, wanted_date):
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"ملف XML غير صالح: {exc}")
    wanted = parse_date(wanted_date)
    records = []
    for node in root.iter():
        if local_name(node.tag) != "G_LOG_TIME":
            continue
        activity_date = child_text(node, "INS_CHAR_DATE")
        try:
            if parse_date(activity_date) != wanted:
                continue
        except ValueError:
            continue
        description = child_text(node, "ACTION_DESCRIPTION")
        guest = extract_guest(description)
        if not guest:
            continue
        room_match = re.search(r"\broom\s+(\d{3,5})\b", description, re.I)
        confirmation_match = re.search(r"Confirmation\s+No\.\s*(\S+)", description, re.I)
        records.append({
            "guest": guest,
            "room": room_match.group(1) if room_match else "",
            "confirmation": confirmation_match.group(1) if confirmation_match else "",
            "time": child_text(node, "INS_CHAR_TIME"),
            "activityDate": activity_date,
        })
    return records

def normalize(value):
    value = (value or "").casefold()
    value = value.replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())

def name_tokens(name):
    # Oracle descriptions commonly use "Surname, Given names".
    if "," in name:
        surname, given = name.split(",", 1)
        surname_tokens = normalize(surname).split()
        given_tokens = normalize(given).split()
        # Require the last surname token and first given-name token.
        return [surname_tokens[-1], given_tokens[0]] if surname_tokens and given_tokens else []
    tokens = normalize(name).split()
    return [tokens[0], tokens[-1]] if len(tokens) >= 2 else tokens

def extract_text(path):
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        import fitz
        with fitz.open(path) as doc:
            return "\n".join(page.get_text("text") for page in doc)
    if suffix == ".docx":
        from docx import Document
        doc = Document(path)
        chunks = [p.text for p in doc.paragraphs]
        for table in doc.tables:
            for row in table.rows:
                chunks.extend(cell.text for cell in row.cells)
        return "\n".join(chunks)
    if suffix == ".msg":
        import extract_msg
        msg = extract_msg.Message(str(path))
        try:
            return "\n".join(filter(None, [msg.subject or "", msg.sender or "", msg.body or ""]))
        finally:
            msg.close()
    if suffix == ".doc":
        # Legacy .doc files are read through Microsoft Word when installed.
        try:
            import win32com.client
            word = win32com.client.DispatchEx("Word.Application")
            word.Visible = False
            document = word.Documents.Open(str(path.resolve()), ReadOnly=True, AddToRecentFiles=False)
            try:
                return document.Content.Text
            finally:
                document.Close(False)
                word.Quit()
        except Exception as exc:
            raise RuntimeError("تعذرت قراءة ملف DOC القديم. ثبّت Microsoft Word على الجهاز أو احفظ الملف بصيغة DOCX.") from exc
    return ""

def contains_guest(text, guest):
    haystack = normalize(text)
    tokens = name_tokens(guest)
    if len(tokens) < 2:
        return False
    # The first and last name are required; middle names are helpful but not mandatory.
    required = [tokens[0], tokens[-1]] if len(tokens) > 2 else tokens
    padded = f" {haystack} "
    return all(f" {token} " in padded for token in required)

def safe_output_name(path, output_dir):
    target = output_dir / path.name
    if not target.exists():
        return target
    stem, suffix = path.stem, path.suffix
    index = 2
    while True:
        candidate = output_dir / f"{stem} ({index}){suffix}"
        if not candidate.exists():
            return candidate
        index += 1

def scan(xml_bytes, wanted_date):
    day, month, year = parse_date(wanted_date)
    records = parse_log(xml_bytes, wanted_date)
    folder = BASE_FOLDER / str(year) / f"{month:02d}" / f"{day:02d}"
    if not folder.is_dir():
        raise FileNotFoundError(f"مجلد تاريخ INS_CHAR_DATE غير موجود:\n{folder}")
    output_dir = Path.home() / "Desktop" / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    files = [p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in EXTENSIONS]
    results = []
    copied_hashes = set()
    text_cache = {}
    for record in records:
        matches = []
        for path in files:
            try:
                if path not in text_cache:
                    text_cache[path] = extract_text(path)
                haystack = text_cache[path]
                if contains_guest(haystack, record["guest"]) or contains_guest(path.name, record["guest"]):
                    matches.append(path)
            except Exception as exc:
                # Keep a diagnostic for unreadable files; continue scanning the rest.
                continue
        copied = []
        for source in matches:
            digest = hashlib.sha256(str(source).encode("utf-8")).hexdigest()
            if digest in copied_hashes:
                continue
            copied_hashes.add(digest)
            destination = safe_output_name(source, output_dir)
            shutil.copy2(source, destination)
            copied.append(destination.name)
        results.append({**record, "status": "matched" if matches else "not_found",
                        "matchedFiles": [p.name for p in matches], "copiedFiles": copied})
    return {
        "date": wanted_date,
        "sourceFolder": str(folder),
        "outputFolder": str(output_dir),
        "records": results,
        "summary": {
            "activities": len(records),
            "matched": sum(1 for item in results if item["status"] == "matched"),
            "notFound": sum(1 for item in results if item["status"] == "not_found"),
            "filesScanned": len(files),
            "copiesCreated": sum(len(item["copiedFiles"]) for item in results),
        },
    }

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = self.headers.get("Origin", "")
        allowed = {item.strip() for item in os.environ.get(
            "USER_ACTIVITY_ALLOWED_ORIGINS",
            "https://nationality.vercel.app,http://localhost:3000,http://127.0.0.1:3000"
        ).split(",") if item.strip()}
        if origin in allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(200, {"ok": True})

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "service": "User Activity Log Local Agent"})
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/scan":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_UPLOAD:
                raise ValueError("حجم ملف log.xml غير صالح أو أكبر من 25MB.")
            raw = self.rfile.read(length)
            content_type = self.headers.get("Content-Type", "")
            message = BytesParser(policy=default).parsebytes(
                b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw
            )
            fields = {}
            for part in message.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name == "file":
                    fields["file"] = part.get_payload(decode=True)
                elif name == "date":
                    fields["date"] = (part.get_payload(decode=True) or b"").decode("utf-8", "replace").strip()
            if not fields.get("file") or not fields.get("date"):
                raise ValueError("اختر ملف log.xml وتأكد من تحديد تاريخ INS_CHAR_DATE.")
            self.send_json(200, scan(fields["file"], fields["date"]))
        except Exception as exc:
            self.send_json(400, {"error": str(exc)})

    def log_message(self, fmt, *args):
        print(fmt % args)

if __name__ == "__main__":
    print("=" * 58)
    print("User Activity Log - Local Windows Agent")
    print(f"Reservation folder: {BASE_FOLDER}")
    print(f"Local endpoint: http://127.0.0.1:{PORT}")
    print("Keep this window open while scanning. Press Ctrl+C to stop.")
    print("=" * 58)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
