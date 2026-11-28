"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFileLibrary, type SharedFolderEntry } from "./file-library-provider";

type InhGuest = {
  room: string;
  name: string;
  company: string;
  arrival: string;
  departure: string;
};

function normalizeRoom(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 3 || digits.length === 4 ? digits.padStart(4, "0") : "";
}

function parseRoomQuery(query: string): string[] {
  const rooms = new Set<string>();
  const parts = query.replace(/(\d{3,4})\s*[-–—]\s*(\d{3,4})/g, "$1-$2")
    .split(/[,،;\s]+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const range = part.match(/^(\d{3,4})-(\d{3,4})$/);
    if (range) {
      const start = Number(normalizeRoom(range[1]));
      const end = Number(normalizeRoom(range[2]));
      if (end < start) throw new Error("نهاية نطاق الغرف يجب أن تكون أكبر من بدايته.");
      if (end - start > 999) throw new Error("النطاق كبير جدًا. اختر نطاقًا لا يتجاوز 1000 غرفة.");
      for (let room = start; room <= end; room++) rooms.add(String(room).padStart(4, "0"));
      continue;
    }
    const room = normalizeRoom(part);
    if (!room) throw new Error("اكتب أرقام الغرف من 3 أو 4 أرقام، واستخدم فاصلة أو نطاقًا مثل 1077-1085.");
    rooms.add(room);
  }
  return [...rooms];
}

function roomsInFilename(name: string) {
  return (name.match(/(?<!\d)\d{3,4}(?!\d)/g) || []).map((room) => room.padStart(4, "0"));
}

async function parseInhPdf(file: File): Promise<InhGuest[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  const guests: InhGuest[] = [];
  const datePattern = /^\d{2}-\d{2}-\d{2}$/;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    const rows: Array<{ y: number; items: Array<{ x: number; text: string }> }> = [];
    for (const raw of text.items) {
      if (!("str" in raw) || !raw.str.trim() || !("transform" in raw)) continue;
      const item = raw as typeof raw & { transform: number[] };
      const x = item.transform[4];
      const y = item.transform[5];
      let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2.5);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x, text: item.str.trim() });
    }

    for (const row of rows) {
      const items = row.items.sort((a, b) => a.x - b.x);
      const roomItem = items.find((item) => item.x < 42 && /^\d{4}$/.test(item.text));
      if (!roomItem) continue;
      const dates = items.map((item) => item.text).filter((value) => datePattern.test(value));
      if (dates.length < 2) continue;
      const name = items.filter((item) => item.x >= 40 && item.x < 160).map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
      const company = items.filter((item) => item.x >= 160 && item.x < 315).map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
      if (!name) continue;
      guests.push({ room: roomItem.text, name, company, arrival: dates[0], departure: dates[1] });
    }
  }

  return guests;
}

export default function RCPreview() {
  const { registrations, setFolderPath, setFolderFiles, refreshFolder, readBytes } = useFileLibrary();
  const [query, setQuery] = useState("");
  const [requestedRooms, setRequestedRooms] = useState<string[]>([]);
  const [inhGuests, setInhGuests] = useState<InhGuest[]>([]);
  const [inhFileName, setInhFileName] = useState("");
  const [results, setResults] = useState<SharedFolderEntry[]>([]);
  const [selected, setSelected] = useState<SharedFolderEntry | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inhInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const pdfEntries = useMemo(
    () => registrations.entries.filter((entry) => entry.name.toLowerCase().endsWith(".pdf")),
    [registrations.entries],
  );
  const visibleGuests = useMemo(() => {
    if (!requestedRooms.length) return [];
    const wanted = new Set(requestedRooms);
    return inhGuests.filter((guest) => wanted.has(guest.room));
  }, [inhGuests, requestedRooms]);
  const visibleRoomGroups = useMemo(() => {
    const groups = new Map<string, InhGuest[]>();
    for (const guest of visibleGuests) {
      const group = groups.get(guest.room) || [];
      group.push(guest);
      groups.set(guest.room, group);
    }
    return [...groups.entries()].map(([room, guests]) => ({ room, guests }));
  }, [visibleGuests]);

  async function uploadInh(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setMessage("يرجى اختيار ملف PDF باسم inh.pdf.");
      return;
    }
    setBusy(true);
    setMessage("جارٍ قراءة ملف INH واستخراج بيانات الغرف...");
    try {
      const guests = await parseInhPdf(file);
      if (!guests.length) throw new Error("لم يتم العثور على سجلات غرف. تأكد أن ملف INH يحتوي على نص قابل للاستخراج وليس صورًا ممسوحة فقط.");
      setInhGuests(guests);
      setInhFileName(file.name);
      setRequestedRooms([]);
      setResults([]);
      setMessage("تم استخراج " + guests.length + " سجل غرفة من " + file.name + ". أدخل أرقام الغرف لعرض بياناتها.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر قراءة ملف INH.");
    } finally {
      setBusy(false);
      if (inhInputRef.current) inhInputRef.current.value = "";
    }
  }

  async function chooseFolder() {
    if (!window.desktopBridge) {
      setMessage("ربط مجلد الملفات متاح من تطبيق سطح المكتب فقط.");
      return;
    }
    try {
      const path = await window.desktopBridge.selectFolder();
      if (!path) return;
      await setFolderPath("registration", path);
      setResults([]);
      setSelected(null);
      setMessage("تم ربط مجلد نماذج التسجيل وتحديث فهرس الملفات.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر ربط المجلد.");
    }
  }

  function searchRooms() {
    try {
      const requested = parseRoomQuery(query);
      if (!requested.length) {
        setMessage("أدخل رقم غرفة أو نطاقًا مثل 1077-1085.");
        return;
      }
      setRequestedRooms(requested);
      const wanted = new Set(requested);
      const matches = pdfEntries.filter((entry) => roomsInFilename(entry.relativePath || entry.name).some((room) => wanted.has(room)));
      setResults(matches);
      setSelected(null);
      setPdfData(null);
      setPageCount(0);
      const guestMatches = inhGuests.filter((guest) => wanted.has(guest.room)).length;
      setMessage("الغرف المطلوبة: " + requested.join("، ") + " — سجلات INH المطابقة: " + guestMatches + " — ملفات RC المطابقة: " + matches.length);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر تنفيذ البحث.");
    }
  }

  async function openPreview(entry: SharedFolderEntry) {
    setBusy(true);
    setMessage("جارٍ تحميل الملف...");
    setSelected(entry);
    setPdfData(null);
    setPageNumber(1);
    setPageCount(0);
    try {
      const bytes = await readBytes("registration", entry);
      setPdfData(bytes);
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      setPageCount(pdf.numPages);
      setMessage("تم فتح الملف. اختر الصفحة التي تريد معاينتها أو طباعتها.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "تعذر فتح ملف PDF.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function renderPage() {
      if (!pdfData || !selected || !canvasRef.current) return;
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: pdfData.slice() }).promise;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.65 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext("2d");
        if (!context) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "تعذر عرض الصفحة.");
      }
    }
    void renderPage();
    return () => { cancelled = true; };
  }, [pdfData, selected, pageNumber]);

  function printCurrentPage() {
    const canvas = canvasRef.current;
    if (!canvas || !selected) {
      setMessage("افتح ملفًا واختر صفحة قبل الطباعة.");
      return;
    }
    const image = canvas.toDataURL("image/png");
    const printFrame = document.createElement("iframe");
    printFrame.style.position = "fixed";
    printFrame.style.width = "0";
    printFrame.style.height = "0";
    printFrame.style.border = "0";
    printFrame.style.right = "0";
    printFrame.style.bottom = "0";
    document.body.appendChild(printFrame);
    const printDocument = printFrame.contentDocument;
    const printWindow = printFrame.contentWindow;
    if (!printDocument || !printWindow) {
      printFrame.remove();
      setMessage("تعذرت تهيئة صفحة الطباعة.");
      return;
    }
    printDocument.open();
    printDocument.write(`<!doctype html><html><head><title>${selected.name} - Page ${pageNumber}</title><style>@page{margin:8mm}html,body{margin:0;padding:0;text-align:center}img{display:block;max-width:100%;max-height:calc(100vh - 16mm);margin:auto;object-fit:contain}@media print{img{width:100%;height:auto}}</style></head><body><img src="${image}" /></body></html>`);
    printDocument.close();
    window.setTimeout(() => {
      printWindow.focus();
      printWindow.print();
      window.setTimeout(() => printFrame.remove(), 1200);
    }, 250);
  }

  return (
    <section className="panel">
      <h2>RC Preview</h2>
      <p className="muted">ارفع تقرير INH لقراءة بيانات النزلاء والغرف، ثم ابحث برقم غرفة أو عدة غرف أو نطاق متتالٍ لعرض بيانات كل غرفة وملف Registration Card المطابق. لا تحتاج الأداة إلى arr.pdf أو arr.xml.</p>
      <div className="upload">
        <label>ملف تقرير الغرف INH (PDF)</label>
        <input ref={inhInputRef} type="file" accept="application/pdf,.pdf" onChange={(event) => void uploadInh(event.target.files?.[0])} />
        <p className="saved-hint">{inhFileName ? "الملف المرفوع: " + inhFileName + " — السجلات المستخرجة: " + inhGuests.length : "اختر ملف inh.pdf لاستخراج رقم الغرفة والاسم والشركة وتاريخي الوصول والمغادرة."}</p>
      </div>
      <div className="upload" style={{ marginTop: 12 }}>
        <label>مجلد نماذج التسجيل PDF</label>
        <button type="button" className="add-button" onClick={chooseFolder}>اختيار / تغيير مجلد النماذج</button>
        {(typeof window === "undefined" || !window.desktopBridge) && <><input ref={folderInputRef} type="file" accept=".pdf,application/pdf" multiple onChange={(event) => { const files = Array.from(event.target.files || []); if (files.length) { setFolderFiles("registration", files); setResults([]); setSelected(null); setPdfData(null); setMessage("تم تحميل " + files.length + " ملفًا من المتصفح. ستظل الملفات متاحة خلال جلسة الصفحة الحالية."); } event.target.value = ""; }} style={{ display: "none" }} /><label className="saved-hint">في المتصفح حدد ملفات Registration Card PDF من جهازك (يمكن تحديد عدة ملفات).</label></>}
        <p className="saved-hint">{registrations.path ? registrations.path : "لم يتم ربط مجلد نماذج التسجيل بعد."}</p>
        <p className="saved-hint">{registrations.loading ? "جارٍ فهرسة الملفات..." : "ملفات PDF في الفهرس: " + pdfEntries.length}</p>
        <button type="button" className="add-button" disabled={registrations.loading || !registrations.path || typeof window === "undefined" || !window.desktopBridge} onClick={() => void refreshFolder("registration").then(() => setMessage("تم تحديث فهرس ملفات PDF.")).catch(() => setMessage("تعذر تحديث الفهرس."))}>تحديث الفهرس</button>
      </div>
      <div className="uploads" style={{ marginTop: 16 }}>
        <label style={{ display: "grid", gap: 8, fontWeight: 700 }}>
          أرقام الغرف
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") searchRooms(); }} placeholder="0102 أو 0102,0103 أو 0102-0115" />
        </label>
        <button type="button" className="button" style={{ marginTop: 0 }} onClick={searchRooms} disabled={registrations.loading}>بحث وعرض بيانات الغرف</button>
      </div>
      {message && <div className="notice" role="status">{message}</div>}
      {visibleGuests.length > 0 && (
        <div className="towel-results">
          <h3>بيانات الغرف من INH ({visibleRoomGroups.length})</h3>
          <div className="folder-results" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {visibleRoomGroups.map((group) => (
              <article key={group.room} className="folder-result" style={{ border: "1px solid #d5e3d8", borderRadius: 12, padding: 14, background: "#f7fbf8" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
                  <strong style={{ fontSize: 18 }}>غرفة {group.room}</strong>
                  <span style={{ color: "#16803d", fontWeight: 800 }}>INH</span>
                </div>
                {group.guests.map((guest, index) => (
                  <div key={group.room + "-" + index} style={{ borderTop: index ? "1px solid #d5e3d8" : "none", paddingTop: index ? 10 : 0, marginTop: index ? 10 : 0 }}>
                    <div style={{ color: "#16803d", fontWeight: 800, fontSize: 17, marginBottom: 10 }}>{guest.name}</div>
                    <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
                      <div><strong>رقم الغرفة:</strong> {guest.room}</div>
                      <div><strong>الشركة:</strong> {guest.company || "غير محددة"}</div>
                      <div><strong>تاريخ الوصول:</strong> {guest.arrival}</div>
                      <div><strong>تاريخ المغادرة:</strong> {guest.departure}</div>
                    </div>
                  </div>
                ))}
              </article>
            ))}
          </div>
        </div>
      )}
      {requestedRooms.length > 0 && visibleGuests.length === 0 && inhGuests.length > 0 && (
        <div className="notice">لم يتم العثور على بيانات INH للغرف المحددة داخل الملف المرفوع.</div>
      )}
      {results.length > 0 && (
        <div className="towel-results">
          <h3>ملفات Registration Card المطابقة ({results.length})</h3>
          <div className="folder-results">
            {results.map((entry) => (
              <div className="folder-result" key={entry.path}>
                <div className="folder-result-top">
                  <div><strong dir="ltr">{entry.relativePath || entry.name}</strong><p className="muted">الغرف في اسم الملف: {roomsInFilename(entry.relativePath || entry.name).join("، ")}</p></div>
                  <button type="button" className="add-button" disabled={busy} onClick={() => void openPreview(entry)}>{selected?.path === entry.path ? "الملف المحدد" : "فتح المعاينة"}</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {selected && pdfData && (
        <div className="towel-results">
          <div className="section-heading">
            <div><h3 dir="ltr">{selected.name}</h3><p className="muted">عدد الصفحات: {pageCount}</p></div>
            <button type="button" className="add-button" onClick={printCurrentPage}>طباعة الصفحة {pageNumber}</button>
          </div>
          <div className="uploads" style={{ margin: "14px 0", alignItems: "center" }}>
            <button type="button" className="add-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}>الصفحة السابقة</button>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>صفحة
              <input type="number" min={1} max={pageCount} value={pageNumber} onChange={(event) => setPageNumber(Math.min(pageCount || 1, Math.max(1, Number(event.target.value) || 1)))} style={{ width: 90 }} />
              من {pageCount}
            </label>
            <button type="button" className="add-button" disabled={pageNumber >= pageCount} onClick={() => setPageNumber((value) => Math.min(pageCount, value + 1))}>الصفحة التالية</button>
          </div>
          <div style={{ background: "#e9eef4", padding: 12, overflow: "auto", textAlign: "center", borderRadius: 10 }}>
            <canvas ref={canvasRef} style={{ maxWidth: "100%", height: "auto", background: "white", boxShadow: "0 2px 12px #0002" }} />
          </div>
        </div>
      )}
    </section>
  );
}
