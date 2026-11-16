"use client";

import { useMemo, useState, type ChangeEvent } from "react";

type Activity = {
  guest: string;
  room: string;
  confirmation: string;
  time: string;
  activityDate: string;
  status: "matched" | "not_found";
  matchedFiles: string[];
  copiedFiles: string[];
};
type ScanResult = {
  date: string;
  sourceFolder: string;
  outputFolder: string;
  records: Activity[];
  summary: { activities: number; matched: number; notFound: number; filesScanned: number; copiesCreated: number };
};

function dateLabel(value: string) {
  const [day, month, year] = value.split("-");
  return day && month && year ? `${day}/${month}/${year}` : value;
}

export default function UserActivityLogPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  const recordCount = useMemo(() => result?.summary.activities ?? 0, [result]);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setDates([]);
    setSelectedDate("");
    setResult(null);
    setMessage("");
    setError(false);
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(".xml")) {
      setError(true);
      setMessage("يجب اختيار ملف log.xml بصيغة XML.");
      return;
    }
    try {
      const xmlText = await selected.text();
      const xml = new DOMParser().parseFromString(xmlText, "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("ملف XML غير صالح.");
      const values = Array.from(xml.getElementsByTagName("INS_CHAR_DATE"))
        .map((node) => (node.textContent || "").trim())
        .filter((value) => /^\d{1,2}-\d{1,2}-\d{2,4}$/.test(value));
      const unique = Array.from(new Set(values));
      if (!unique.length) throw new Error("لم أجد INS_CHAR_DATE داخل التقرير.");
      setDates(unique);
      setSelectedDate(unique[0]);
      setMessage(`تمت قراءة التقرير. يحتوي على ${unique.length} تاريخ نشاط مختلف.`);
    } catch (e) {
      setError(true);
      setMessage(e instanceof Error ? e.message : "تعذرت قراءة ملف XML.");
    }
  }

  async function runScan() {
    if (!file || !selectedDate) {
      setError(true);
      setMessage("اختر ملف log.xml وحدد تاريخ INS_CHAR_DATE.");
      return;
    }
    setBusy(true);
    setResult(null);
    setError(false);
    setMessage("جارٍ الاتصال ببرنامج Windows المحلي والبحث في ملفات الحجوزات...");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("date", selectedDate);
      const response = await fetch("http://127.0.0.1:8765/scan", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "تعذر تنفيذ البحث.");
      setResult(data as ScanResult);
      setMessage("اكتمل البحث ونسخ الملفات المطابقة.");
    } catch (e) {
      setError(true);
      const reason = e instanceof Error ? e.message : "";
      setMessage(reason.includes("Failed to fetch") || reason.includes("NetworkError")
        ? "لم أتمكن من الاتصال بالبرنامج المحلي. شغّل start-agent.bat على جهاز Windows واترك نافذة البرنامج مفتوحة، ثم أعد المحاولة."
        : reason || "حدث خطأ أثناء البحث.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page" dir="rtl">
      <header className="hero">
        <p className="eyebrow">أدوات الفندق · Hotel Operations</p>
        <h1>User Activity Log</h1>
        <p>اقرأ سجل Oracle، وابحث عن ملفات حجوزات النزلاء في مجلد اليوم، ثم انسخ الملفات المطابقة إلى Desktop/output دون المساس بالملفات الأصلية.</p>
      </header>

      <section className="panel">
        <h2>1. رفع تقرير Oracle</h2>
        <p className="muted">اختر ملف log.xml. ستقرأ الأداة تواريخ INS_CHAR_DATE الموجودة داخله لتحديد يوم البحث.</p>
        <div className="upload">
          <label htmlFor="activity-log-file">Oracle User Activity Log — log.xml</label>
          <input id="activity-log-file" type="file" accept=".xml,text/xml,application/xml" onChange={selectFile} />
          {file && <div className="filename">الملف المختار: {file.name}</div>}
        </div>
        {dates.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <label htmlFor="activity-date" style={{ display: "block", fontWeight: 700, marginBottom: 9 }}>تاريخ النشاط — INS_CHAR_DATE</label>
            <select id="activity-date" value={selectedDate} onChange={(e) => { setSelectedDate(e.target.value); setResult(null); }}
              style={{ width: "100%", minHeight: 44, padding: 10, border: "1px solid #cbd6e2", borderRadius: 9, background: "#fff", color: "#172b4d", font: "inherit" }}>
              {dates.map((date) => <option key={date} value={date}>{dateLabel(date)}</option>)}
            </select>
            <p className="saved-hint">سيتم استخدام هذا التاريخ فقط في مسار المجلد: YYYY / MM / DD. لن نستخدم تاريخ Check-in الموجود داخل ACTION_DESCRIPTION.</p>
          </div>
        )}
        <button type="button" className="button" onClick={runScan} disabled={busy || !file || !selectedDate}>
          {busy ? "جارٍ البحث..." : "Search reservations and copy matches"}
        </button>
        {message && <div role="status" className={"notice" + (error ? " error" : result ? " success" : "")}>{message}</div>}
      </section>

      <section className="panel">
        <h2>2. برنامج Windows المحلي</h2>
        <p className="muted">هذه الصفحة تحتاج إلى تشغيل البرنامج المحلي على نفس جهاز Windows الذي يستطيع الوصول إلى القرص L:. لا يمكن لخادم الموقع الوصول إلى ملفات جهازك مباشرة.</p>
        <ol className="steps">
          <li>نزّل مجلد <b>tools/user-activity-log</b> من الريبو إلى جهاز الفندق.</li>
          <li>شغّل الملف <b>start-agent.bat</b> وانتظر حتى تظهر رسالة Local endpoint: http://127.0.0.1:8765.</li>
          <li>اترك نافذة البرنامج مفتوحة أثناء استخدام الأداة.</li>
        </ol>
        <p className="saved-hint">يبحث البرنامج داخل L:\Common\Linked Documents\1-Reservation Data Long Beach\السنة\الشهر\اليوم، ويدعم MSG وDOC وDOCX وPDF. ملفات DOC القديمة تحتاج إلى Microsoft Word مثبتًا.</p>
      </section>

      {result && (
        <>
          <section className="panel">
            <h2>3. ملخص البحث</h2>
            <div className="stats-grid">
              <div><strong>{result.summary.activities}</strong><span>سجلات النشاط</span></div>
              <div><strong>{result.summary.matched}</strong><span>نزلاء لهم ملفات مطابقة</span></div>
              <div><strong>{result.summary.notFound}</strong><span>لم يتم العثور على ملفات</span></div>
              <div><strong>{result.summary.copiesCreated}</strong><span>ملفات تم نسخها</span></div>
            </div>
            <p className="saved-hint">تم فحص {result.summary.filesScanned} ملف داخل: <b dir="ltr">{result.sourceFolder}</b></p>
            <p className="saved-hint">مكان النسخ: <b dir="ltr">{result.outputFolder}</b></p>
          </section>
          <section className="panel">
            <h2>4. تفاصيل النزلاء ({recordCount})</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>الحالة</th><th>اسم النزيل</th><th>الغرفة</th><th>Confirmation No.</th><th>الوقت</th><th>الملفات المطابقة</th></tr></thead>
                <tbody>
                  {result.records.map((row, index) => (
                    <tr key={row.confirmation + "-" + index}>
                      <td><span style={{ color: row.status === "matched" ? "#236b38" : "#a42d2d", fontWeight: 700 }}>{row.status === "matched" ? "تم العثور" : "غير موجود"}</span></td>
                      <td>{row.guest}</td><td>{row.room}</td><td>{row.confirmation}</td><td>{row.time}</td>
                      <td style={{ minWidth: 220, whiteSpace: "normal" }}>
                        {row.matchedFiles.length ? row.matchedFiles.map((name) => <div key={name}>{name}</div>) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      <p className="foot">User Activity Log · Local search · Original reservation files remain unchanged.</p>
    </main>
  );
}
