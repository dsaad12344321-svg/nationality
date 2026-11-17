"use client";

import { useMemo, useRef, useState } from "react";

type Guest = { name: string; dob: string };
type Reservation = {
  confirmation: string;
  room: string;
  company: string;
  originalFile: string;
  guests: Guest[];
};

const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const aliases = {
  confirmation: ["confirmationno", "confirmationnumber", "confirmation", "confno", "bookingnumber", "operatorvoucherno", "voucherno"],
  room: ["roomno", "roomnumber", "room", "roomid"],
  company: ["company", "companyname", "operator", "agency", "touroperator"],
  originalFile: ["originalfilename", "originalfile", "filename", "sourcefile", "commonfilename", "file"],
  guestName: ["fullname", "guestname", "name", "touristname", "passengername", "namesurname"],
  dob: ["dateofbirth", "dob", "birthdate", "birthday"],
};

function keyOf(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function textOf(node: Element | null): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function directValue(node: Element, keys: string[]): string {
  for ( (const child of Array.from(node.children)) ) {
    if (keys.includes(keyOf(child.tagName))) {
      const value = textOf(child);
      if (value) return value;
    }
  }
  for (const attr of Array.from(node.attributes)) {
    if (keys.includes(keyOf(attr.name)) && attr.value.trim()) return attr.value.trim();
  }
  return "";
}

function parseReservations(xml: string): Reservation[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("ملف XML غير صالح أو لا يمكن قراءته.");

  const all = Array.from(doc.getElementsByTagName("*"));
  const candidates = all.filter((node) =>
    directValue(node, aliases.confirmation) && directValue(node, aliases.room)
  );

  const records: Reservation[] = [];
  for (const node of candidates) {
    const confirmation = directValue(node, aliases.confirmation);
    const room = directValue(node, aliases.room);
    const company = directValue(node, aliases.company);
    const originalFile = directValue(node, aliases.originalFile);
    const guests: Guest[] = [];

    const guestNodes = Array.from(node.getElementsByTagName("*")).filter((child) =>
      directValue(child, aliases.guestName) ||
      (aliases.guestName.includes(keyOf(child.tagName)) && textOf(child))
    );

    for (const guestNode of guestNodes) {
      let name = directValue(guestNode, aliases.guestName);
      if (!name && aliases.guestName.includes(keyOf(guestNode.tagName))) name = textOf(guestNode);
      const dob = directValue(guestNode, aliases.dob);
      if (name && !guests.some((g) => g.name === name && g.dob === dob)) guests.push({ name, dob });
    }

    // Also support a compact <Guests> text field, where each person is on its own line.
    if (!guests.length) {
      const raw = directValue(node, ["guests", "guestnames", "passengers", "tourists"]);
      for (const line of raw.split(/[\r\n;]+/).map((s) => s.trim()).filter(Boolean)) {
        const match = line.match(/^(.*?)(?:\s{2,}|\s+-\s+)(\d{2}[./-]\d{2}[./-]\d{4})$/);
        guests.push({ name: match?.[1]?.trim() || line, dob: match?.[2] || "" });
      }
    }

    if (!records.some((r) => r.confirmation === confirmation && r.room === room && r.originalFile === originalFile)) {
      records.push({ confirmation, room, company, originalFile, guests });
    }
  }
  return records;
}

export default function GuestNameExtractorPage() {
  const [records, setRecords] = useState<Reservation[]>([]);
  const [query, setQuery] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return records;
    return records.filter((r) => norm([
      r.confirmation, r.room, r.company, r.originalFile,
      ...r.guests.flatMap((g) => [g.name, g.dob]),
    ].join(" ")).includes(q));
  }, [records, query]);

  async function loadFile(file?: File) {
    if (!file) return;
    setError("");
    setCopied("");
    try {
      const parsed = parseReservations(await file.text());
      if (!parsed.length) throw new Error("لم أجد سجلات حجوزات. تأكد أن الملف هو Reservation Detail.xml وأنه يحتوي على Confirmation No. ورقم الغرفة.");
      setRecords(parsed);
      setFileName(file.name);
      setQuery("");
    } catch (e) {
      setRecords([]);
      setError(e instanceof Error ? e.message : "تعذر قراءة ملف XML.");
    }
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError("تعذر النسخ تلقائياً. تحقق من صلاحية Clipboard في المتصفح.");
    }
  }

  function guestText(r: Reservation) {
    return r.guests.map((g) => [g.name, g.dob].filter(Boolean).join("  ")).join("\n");
  }

  return (
    <main className="page" dir="rtl">
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ابحث داخل ملف Reservation Detail.xml برقم الحجز أو الغرفة أو اسم النزيل أو الشركة، وانسخ أسماء النزلاء وتواريخ ميلادهم بسهولة.</p>
      </header>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>1. تحميل ملف الحجوزات</h2>
            <p className="muted">اختر ملف Reservation Detail.xml الذي تم إنشاؤه بواسطة أداة البحث. تتم قراءة الملف داخل المتصفح ولا يتم رفعه إلى خادم.</p>
          </div>
          <button type="button" className="add-button" onClick={() => fileRef.current?.click()}>اختيار ملف XML</button>
          <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
        </div>
        {fileName && <p className="filename">الملف الحالي: {fileName} · عدد الحجوزات: {records.length}</p>}
        {error && <div className="notice error">{error}</div>}
      </section>

      <section className="panel">
        <h2>2. البحث عن حجز أو نزيل</h2>
        <p className="muted">اكتب Confirmation Number أو رقم الغرفة أو اسم النزيل أو اسم الشركة.</p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by confirmation, room, guest name, company..."
          aria-label="Search reservations"
          style={{ width: "100%", minHeight: 52, border: "1px solid #cbd6e2", borderRadius: 10, padding: "12px 16px", font: "inherit", direction: "ltr", textAlign: "left" }}
        />
        <p className="saved-hint">النتائج: {filtered.length} من {records.length} حجز</p>
      </section>

      {filtered.map((r, index) => (
        <section className="panel" key={r.confirmation + "-" + r.room + "-" + index}>
          <div className="section-heading">
            <div>
              <h2>Confirmation No. {r.confirmation}</h2>
              <p className="muted">Room: {r.room} {r.company ? " · Company: " + r.company : ""}</p>
            </div>
            <button type="button" className="add-button" onClick={() => copyText(guestText(r), "reservation-" + index)}>
              نسخ جميع الأسماء
            </button>
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            {r.guests.length ? r.guests.map((g, guestIndex) => (
              <div key={guestIndex} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", border: "1px solid #e1e8f0", borderRadius: 10, background: "#f9fbfd" }}>
                <div>
                  <strong>{g.name}</strong>
                  {g.dob && <div className="muted" style={{ margin: "4px 0 0", direction: "ltr", textAlign: "left" }}>{g.dob}</div>}
                </div>
                <button type="button" className="add-button" onClick={() => copyText([g.name, g.dob].filter(Boolean).join("  "), "guest-" + index + "-" + guestIndex)}>نسخ</button>
              </div>
            )) : <p className="muted">لم يتم العثور على أسماء نزلاء في هذا السجل.</p>}
          </div>
          {r.originalFile && <p className="saved-hint">Original file: <span dir="ltr">{r.originalFile}</span></p>}
          {copied === "reservation-" + index && <div className="notice success">تم نسخ جميع الأسماء.</div>}
          {copied.startsWith("guest-" + index + "-") && <div className="notice success">تم نسخ الاسم.</div>}
        </section>
      ))}

      {records.length > 0 && filtered.length === 0 && <section className="panel"><p className="muted">لا توجد نتائج مطابقة لعبارة البحث.</p></section>}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </main>
  );
}
