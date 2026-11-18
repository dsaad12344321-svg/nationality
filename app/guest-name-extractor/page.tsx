"use client";

import { useMemo, useRef, useState } from "react";

type Guest = { name: string; dob: string };
type Reservation = {
  confirmation: string;
  room: string;
  company: string;
  originalFile: string;
  logGuestName: string;
  activityDate: string;
  activityTime: string;
  action: string;
  guests: Guest[];
};

const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const aliases = {
  confirmation: ["confirmationno", "confirmationnumber", "confirmation", "confno", "bookingnumber", "operatorvoucherno", "voucherno"],
  room: ["roomno", "roomnumber", "room", "roomid"],
  company: ["company", "companyname", "operator", "agency", "touroperator"],
  originalFile: ["originalfilename", "originalfile", "filename", "sourcefile", "commonfilename", "file"],
  guestName: ["fullname", "guestname", "name", "touristname", "passengername", "namesurname"],
  lastName: ["lastname", "surname", "familyname"],
  firstName: ["firstname", "givenname", "forename"],
  dob: ["dateofbirth", "dob", "birthdate", "birthday"],
  logGuestName: ["logguestname", "activityguestname"],
  activityDate: ["inschardate", "activitydate", "logdate"],
  activityTime: ["inschartime", "activitytime", "logtime"],
  action: ["actiontype", "action"],
};

function keyOf(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function textOf(node: Element | null): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() || "";
}

function directValue(node: Element, keys: string[]): string {
  for (const child of Array.from(node.children)) {
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
    const logGuestName = directValue(node, aliases.logGuestName);
    const activityDate = directValue(node, aliases.activityDate);
    const activityTime = directValue(node, aliases.activityTime);
    const action = directValue(node, aliases.action);
    const guests: Guest[] = [];

    const descendants = Array.from(node.getElementsByTagName("*"));
    let guestNodes = descendants.filter((child) => directValue(child, aliases.guestName));
    if (!guestNodes.length) {
      guestNodes = descendants.filter((child) =>
        aliases.guestName.includes(keyOf(child.tagName)) && child.children.length === 0 && textOf(child)
      );
    }

    // Reservation Detail files may store tourists as separate LAST_NAME / FIRST_NAME
    // fields inside a tourist row rather than one combined NAME field.
    const touristRows = descendants.filter((child) =>
      directValue(child, aliases.lastName) || directValue(child, aliases.firstName) ||
      directValue(child, aliases.guestName)
    ).filter((child) => {
      const last = directValue(child, aliases.lastName);
      const first = directValue(child, aliases.firstName);
      const combined = directValue(child, aliases.guestName);
      return Boolean((last || first || combined) && directValue(child, aliases.dob) !== "");
    });

    const rowsToRead = touristRows.length ? touristRows : guestNodes;
    for (const guestNode of rowsToRead) {
      const last = directValue(guestNode, aliases.lastName);
      const first = directValue(guestNode, aliases.firstName);
      let name = directValue(guestNode, aliases.guestName);
      if (last || first) {
        name = [last, first].filter(Boolean).join(", ");
      } else if (!name && aliases.guestName.includes(keyOf(guestNode.tagName))) {
        name = textOf(guestNode);
      }
      const dob = directValue(guestNode, aliases.dob);
      if (name) {
        // Normalize slash-form names such as VAGNER/ALEKSANDR to LAST, FIRST.
        if (!last && !first && name.includes("/") && !name.includes(","))
          name = name.split("/").map((part) => part.trim()).filter(Boolean).join(", ");
        if (!guests.some((g) => g.name === name && g.dob === dob)) guests.push({ name, dob });
      }
    }

    if (!guests.length) {
      const raw = directValue(node, ["guests", "guestnames", "passengers", "tourists"]);
      for (const line of raw.split(/[\r\n;]+/).map((s) => s.trim()).filter(Boolean)) {
        const match = line.match(/^(.*?)(?:\s{2,}|\s+-\s+)(\d{2}[./-]\d{2}[./-]\d{4})$/);
        guests.push({ name: match?.[1]?.trim() || line, dob: match?.[2] || "" });
      }
    }

    const reservation: Reservation = {
      confirmation, room, company, originalFile, logGuestName,
      activityDate, activityTime, action, guests,
    };
    if (!records.some((r) =>
      r.confirmation === confirmation && r.room === room &&
      r.originalFile === originalFile && r.activityDate === activityDate
    )) records.push(reservation);
  }
  return records;
}

export default function GuestNameExtractorPage() {
  const [records, setRecords] = useState<Reservation[]>([]);
  const [query, setQuery] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");
  const [timeOrder, setTimeOrder] = useState<"asc" | "desc">("asc");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const companies = useMemo(
    () => Array.from(new Set(records.map((r) => r.company).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [records]
  );

  const filtered = useMemo(() => {
    const q = norm(query);
    const matches = records.filter((r) => {
      if (companyFilter && r.company !== companyFilter) return false;
      if (!q) return true;
      return norm([
        r.confirmation, r.room, r.company, r.originalFile, r.logGuestName,
        r.activityDate, r.activityTime, r.action,
        ...r.guests.flatMap((g) => [g.name, g.dob]),
      ].join(" ")).includes(q);
    });
    const toTimestamp = (r: Reservation) => {
      const date = r.activityDate.match(/^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2,4})$/);
      const time = r.activityTime.match(/^(\\d{1,2}):(\\d{2})/);
      if (!date) return Number.NaN;
      const year = Number(date[3]) < 100 ? 2000 + Number(date[3]) : Number(date[3]);
      return new Date(year, Number(date[2]) - 1, Number(date[1]), Number(time?.[1] || 0), Number(time?.[2] || 0)).getTime();
    };
    return matches.sort((a, b) => {
      const left = toTimestamp(a), right = toTimestamp(b);
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      return timeOrder === "asc" ? left - right : right - left;
    });
  }, [records, query, companyFilter, timeOrder]);

  async function loadFile(file?: File) {
    if (!file) return;
    setError("");
    setCopied("");
    try {
      const parsed = parseReservations(await file.text());
      if (!parsed.length) throw new Error("لم أجد سجلات حجوزات. تأكد أن الملف يحتوي على CONFIRMATION_NO وROOM_NO.");
      setRecords(parsed);
      setFileName(file.name);
      setQuery("");
      setCompanyFilter("");
    } catch (e) {
      setRecords([]);
      setFileName("");
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
    return r.guests.map((g) => [g.name, g.dob].filter(Boolean).join(" — ")).join("\n");
  }

  function downloadCsv() {
    const rows = [
      ["Confirmation No", "Room", "Company", "Guest Names", "Original File", "Activity Date", "Activity Time", "Action"],
      ...filtered.map((r) => [
        r.confirmation, r.room, r.company,
        r.guests.map((g) => [g.name, g.dob].filter(Boolean).join(" — ")).join(" | "),
        r.originalFile, r.activityDate, r.activityTime, r.action,
      ]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map((cell) => '"' + String(cell ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "Reservation-Detail-filtered.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page" dir="rtl">
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ارفع Reservation Detail.xml لعرض تقرير الحجوزات، والبحث برقم الحجز أو الغرفة أو اسم النزيل أو الشركة، مع فلترة النتائج ونسخ الأسماء.</p>
      </header>

      <section className="panel">
        <div className="section-heading">
          <div>
            <h2>1. تحميل ملف الحجوزات</h2>
            <p className="muted">اختر Reservation Detail.xml الناتج من أداة البحث. تتم قراءة الملف محلياً داخل المتصفح ولا يتم إرساله إلى الخادم.</p>
          </div>
          <button type="button" className="add-button" onClick={() => fileRef.current?.click()}>اختيار ملف XML</button>
          <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" hidden onChange={(e) => { loadFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />
        </div>
        {fileName && <p className="filename">الملف الحالي: {fileName} · عدد الحجوزات: {records.length}</p>}
        {error && <div className="notice error">{error}</div>}
      </section>

      {records.length > 0 && (
        <>
          <section className="panel">
            <h2>2. البحث والفلترة</h2>
            <p className="muted">يمكنك البحث في رقم التأكيد، رقم الغرفة، اسم النزيل، تاريخ الميلاد، الشركة، اسم الملف، وتاريخ أو وقت الحركة.</p>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 2fr) minmax(180px, 1fr)", gap: 12 }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Confirmation / Room / Guest / Company..."
                aria-label="Search reservations"
                style={{ width: "100%", minHeight: 48, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit", direction: "ltr", textAlign: "left" }}
              />
              <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} aria-label="فلترة حسب الشركة" style={{ minHeight: 48, border: "1px solid #cbd6e2", borderRadius: 10, padding: "8px 12px", font: "inherit", background: "white" }}>
                <option value="">كل الشركات</option>
                {companies.map((company) => <option key={company} value={company}>{company}</option>)}
              </select>
              <select value={timeOrder} onChange={(e) => setTimeOrder(e.target.value as "asc" | "desc")} aria-label="ترتيب الحجوزات حسب الوقت" style={{ minHeight: 48, border: "1px solid #cbd6e2", borderRadius: 10, padding: "8px 12px", font: "inherit", background: "white" }}>
                <option value="asc">الأقدم أولاً (تصاعدي)</option>
                <option value="desc">الأحدث أولاً (تنازلي)</option>
              </select>
            </div>
            <div className="section-heading" style={{ marginTop: 12 }}>
              <p className="saved-hint">النتائج المعروضة: {filtered.length} من {records.length} حجز</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="add-button" onClick={() => { setQuery(""); setCompanyFilter(""); }}>مسح الفلاتر</button>
                <button type="button" className="add-button" onClick={downloadCsv} disabled={!filtered.length}>تصدير النتائج CSV</button>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>3. تقرير الحجوزات</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Confirmation No.</th><th>Room</th><th>Company</th><th>Guests (Last name, First name — DOB)</th><th>Activity Date</th><th>Time</th><th>Original File</th></tr>
                </thead>
                <tbody>
                  {filtered.map((r, index) => (
                    <tr key={r.confirmation + "-" + r.room + "-" + r.originalFile + "-" + index}>
                      <td dir="ltr">{r.confirmation}</td>
                      <td dir="ltr">{r.room}</td>
                      <td>{r.company || "—"}</td>
                      <td style={{ minWidth: 220, whiteSpace: "normal" }}>
                        {r.guests.map((g, i) => <div key={i} style={{ marginBottom: 4 }}><strong>{g.name}{g.dob ? " — " + g.dob : ""}</strong></div>)}
                        {r.guests.length > 0 && <button type="button" className="add-button" style={{ marginTop: 6 }} onClick={() => copyText(guestText(r), "table-" + index)}>نسخ الأسماء</button>}
                        {copied === "table-" + index && <div className="notice success">تم النسخ.</div>}
                      </td>
                      <td dir="ltr">{r.activityDate || "—"}</td>
                      <td dir="ltr">{r.activityTime || "—"}</td>
                      <td dir="ltr" style={{ whiteSpace: "normal", minWidth: 180 }}>{r.originalFile || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && <p className="muted">لا توجد نتائج مطابقة للفلاتر الحالية.</p>}
          </section>

          {filtered.map((r, index) => (
            <section className="panel" key={"details-" + r.confirmation + "-" + r.room + "-" + index}>
              <div className="section-heading">
                <div>
                  <h2>Confirmation No. {r.confirmation}</h2>
                  <p className="muted">Room: {r.room}{r.company ? " · Company: " + r.company : ""}</p>
                  {r.action && <p className="muted">Action: {r.action}</p>}
                </div>
                <button type="button" className="add-button" onClick={() => copyText(guestText(r), "reservation-" + index)} disabled={!r.guests.length}>نسخ جميع الأسماء</button>
              </div>
              <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
                {r.guests.length ? r.guests.map((g, guestIndex) => (
                  <div key={guestIndex} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", border: "1px solid #e1e8f0", borderRadius: 10, background: "#f9fbfd" }}>
                    <div>
                      <strong>{g.name}{g.dob ? " — " + g.dob : ""}</strong>
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
        </>
      )}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}
