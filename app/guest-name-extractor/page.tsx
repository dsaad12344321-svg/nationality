"use client";

import { useMemo, useRef, useState } from "react";

type IndexedFile = {
  id: string; name: string; path: string; company: string; extension: string;
  size: number; content: string; pages: string[]; file: File;
};
type SearchResult = IndexedFile & { matchedPages: number[] };

const SUPPORTED = new Set(["pdf", "docx", "msg", "txt", "csv", "xml", "html", "htm", "eml", "log"]);
const normalize = (value: string) =>
  value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function getCompany(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 3 ? parts[1] : "غير محددة";
}

async function extractText(file: File, extension: string): Promise<{ content: string; pages: string[] }> {
  if (["txt", "csv", "xml", "html", "htm", "eml", "log"].includes(extension)) {
    const content = await file.text();
    return { content, pages: [content] };
  }
  const buffer = await file.arrayBuffer();
  if (extension === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });
    return { content: result.value || "", pages: [result.value || ""] };
  }
  if (extension === "msg") {
    const { MsgReader } = await import("@kenjiuno/msgreader-web-ng");
    const message = new MsgReader(buffer);
    const data = message.getFileData();
    const content = [data.subject, data.senderName, data.senderEmail, data.body, data.headers,
      ...(data.recipients || []).map((recipient) => recipient.name)].filter(Boolean).join("\n");
    return { content, pages: [content] };
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return { content: pages.join("\n"), pages };
  }
  return { content: "", pages: [""] };
}

function titleCaseName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/(^|[\s'-])([\p{L}])/gu,
    (_match, separator: string, letter: string) => separator + letter.toLocaleUpperCase());
}

function extractPeople(text: string, searchTerm: string) {
  const clean = text.replace(/[\t|]+/g, " ").replace(/\s+/g, " ");
  const datePattern = "(?:\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}|\\d{4}[\\/-]\\d{1,2}[\\/-]\\d{1,2}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})";
  const dates: string[] = [];
  const dateRegex = new RegExp("(?:date\\s*of\\s*birth|birth\\s*date|dob|d\\.o\\.b\\.?|تاريخ\\s*الميلاد)\\s*[:#-]?\\s*(" + datePattern + ")", "gi");
  for (const match of clean.matchAll(dateRegex)) dates.push(match[1]);
  const names: string[] = [];
  const nameRegex = /(?:guest\s*name|passenger\s*name|full\s*name|name\s*of\s*guest|guest|passenger|الاسم|اسم\s*النزيل)\s*[:#-]?\s*([\p{L}][\p{L}\s'.-]{2,60}?)(?=\s+(?:date\s*of\s*birth|birth\s*date|dob|d\.o\.b\.?|passport|nationality|room|تاريخ\s*الميلاد)\b|[,;|]|$)/giu;
  for (const match of clean.matchAll(nameRegex)) {
    const candidate = match[1].trim();
    if (candidate && !names.some((name) => normalize(name) === normalize(candidate))) names.push(candidate);
  }
  if (!names.length && searchTerm.trim()) {
    const escaped = searchTerm.trim().replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
    const found = clean.match(new RegExp(escaped, "i"));
    if (found) names.push(found[0]);
  }
  return names.map((name, index) => ({
    name: titleCaseName(name),
    dob: dates[index] || (dates.length === 1 ? dates[0] : "لم يُعثر عليه"),
  }));
}

export default function GuestNameExtractorPage() {
  const [files, setFiles] = useState<IndexedFile[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [folderName, setFolderName] = useState("");
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrl = useMemo(() => selected ? URL.createObjectURL(selected.file) : "", [selected]);

  const results = useMemo<SearchResult[]>(() => {
    const q = normalize(query);
    if (!q) return [];
    return files.flatMap((item) => {
      const matchedPages = item.pages.reduce<number[]>((acc, page, index) => {
        if (normalize([item.name, item.path, item.company, page].join(" ")).includes(q)) acc.push(index + 1);
        return acc;
      }, []);
      if (normalize([item.name, item.path, item.company].join(" ")).includes(q) && !matchedPages.length) {
        matchedPages.push(1);
      }
      return matchedPages.length ? [{ ...item, matchedPages }] : [];
    });
  }, [files, query]);

  const companies = useMemo(() => new Set(files.map((file) => file.company).filter((name) => name !== "غير محددة")).size, [files]);
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);
  const pageText = selected?.pages[currentPage - 1] || "";
  const extractedPeople = useMemo(() => extractPeople(pageText, query), [pageText, query]);

  async function scanFolder(selectedFiles: FileList | null) {
    if (!selectedFiles?.length) return;
    const allFiles = Array.from(selectedFiles);
    const root = allFiles[0].webkitRelativePath?.split("/")[0] || "المجلد المحدد";
    const readable = allFiles.filter((file) => SUPPORTED.has(file.name.split(".").pop()?.toLowerCase() || ""));
    setBusy(true); setError(""); setWarnings([]); setFiles([]); setQuery(""); setSelected(null);
    setFolderName(root); setProgress({ done: 0, total: readable.length });
    const indexed: IndexedFile[] = []; const failed: string[] = [];
    for (let index = 0; index < readable.length; index++) {
      const file = readable[index]; const extension = file.name.split(".").pop()?.toLowerCase() || "";
      const path = file.webkitRelativePath || file.name;
      try {
        const extracted = await extractText(file, extension);
        indexed.push({ id: path + "-" + file.lastModified + "-" + index, name: file.name, path,
          company: getCompany(path), extension, size: file.size, content: extracted.content,
          pages: extracted.pages, file });
      } catch { failed.push(path); }
      setProgress({ done: index + 1, total: readable.length });
    }
    setFiles(indexed); setWarnings(failed); setBusy(false);
    if (!readable.length) setError("لم أجد ملفات مدعومة داخل المجلد. الملفات المدعومة: PDF وWord DOCX وOutlook MSG وTXT وCSV وXML.");
    else if (!indexed.length) setError("تعذرت قراءة الملفات المحددة. تحقق من سلامة الملفات ثم حاول مرة أخرى.");
  }

  function openPreview(item: SearchResult) {
    setSelected(item);
    setCurrentPage(item.matchedPages[0] || 1);
  }

  function printOriginal() {
    if (!selected) return;
    const url = URL.createObjectURL(selected.file);
    const printWindow = window.open(url, "_blank");
    if (printWindow) {
      const timer = window.setInterval(() => {
        try {
          if (printWindow.document.readyState === "complete") {
            window.clearInterval(timer);
            printWindow.focus();
            printWindow.print();
          }
        } catch { /* Native PDF viewer controls printing when cross-origin access is restricted. */ }
      }, 700);
      window.setTimeout(() => window.clearInterval(timer), 10000);
    }
  }

  function formatSize(bytes: number) {
    return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  return (
    <div className="page" dir="rtl">
      <header className="hero">
        <p className="eyebrow">Long Beach Resort · Hotel Tools</p>
        <h1>Guest Name Extractor</h1>
        <p>ابحث داخل ملفات الحجوزات، اعرض المستند الأصلي واطبعه، واستخرج أسماء النزلاء وتواريخ الميلاد من الصفحة المعروضة.</p>
      </header>
      <section className="panel">
        <div className="section-heading">
          <div><h2>1. اختيار مجلد الحجوزات بالكامل</h2>
            <p className="muted">اختر المجلد الرئيسي. تتم قراءة الملفات محلياً داخل المتصفح دون رفعها إلى الخادم.</p></div>
          <button type="button" className="add-button" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? "جارٍ فحص المجلد..." : "اختيار مجلد"}
          </button>
          <input ref={inputRef} type="file" multiple hidden
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => { void scanFolder(event.currentTarget.files); event.currentTarget.value = ""; }} />
        </div>
        {folderName && <div className="filename">المجلد: {folderName}</div>}
        {busy && <div className="folder-progress" role="status">
          <div className="progress-track"><span style={{ width: progress.total ? (progress.done / progress.total * 100) + "%" : "0%" }} /></div>
          <p className="saved-hint">جارٍ فحص الملفات: {progress.done} من {progress.total}</p>
        </div>}
        {error && <div className="notice error">{error}</div>}
        {warnings.length > 0 && <div className="notice">تعذرت قراءة {warnings.length} ملف، وتم استكمال فحص بقية الملفات.</div>}
      </section>

      {files.length > 0 && <>
        <section className="panel">
          <h2>2. البحث بالاسم أو الشركة</h2>
          <p className="muted">ستظهر الملفات والصفحات المطابقة. اضغط على معاينة لعرض الصفحة واستخراج الاسم وتاريخ الميلاد منها.</p>
          <input value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="اكتب اسم النزيل أو اسم الشركة..." aria-label="البحث باسم النزيل أو الشركة"
            style={{ width: "100%", minHeight: 50, border: "1px solid #cbd6e2", borderRadius: 10, padding: "10px 14px", font: "inherit" }} />
          <div className="folder-stats">
            <div><strong>{files.length}</strong><span>ملف تمت قراءته</span></div>
            <div><strong>{companies}</strong><span>شركة/مجلد شركة</span></div>
            <div><strong>{formatSize(totalSize)}</strong><span>إجمالي حجم الملفات</span></div>
          </div>
          {query.trim() && <p className="saved-hint">عدد الصفحات/المستندات المطابقة: {results.length}</p>}
        </section>
        {query.trim() && <section className="panel">
          <h2>3. نتائج البحث</h2>
          {results.length ? <div className="folder-results">{results.map((item) => (
            <article className="folder-result" key={item.id + item.matchedPages.join(",")}>
              <div className="folder-result-top"><div>
                <strong>{item.name}</strong>
                <p className="muted">الشركة: {item.company} · النوع: {item.extension.toUpperCase()} · الحجم: {formatSize(item.size)}</p>
                <p className="muted">الصفحات المطابقة: {item.matchedPages.join(", ")}</p>
              </div><button type="button" className="add-button" onClick={() => openPreview(item)}>معاينة واستخراج</button></div>
              <p className="folder-path" dir="ltr">{item.path}</p>
            </article>
          ))}</div> : <p className="empty-exclusions">لا توجد ملفات تحتوي على كلمة البحث.</p>}
        </section>}
      </>}

      {selected && <section className="panel" aria-label="معاينة المستند">
        <div className="section-heading">
          <div><h2>4. معاينة المستند واستخراج البيانات</h2>
            <p className="muted">{selected.name} · {selected.company}</p></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="add-button" onClick={printOriginal}>طباعة الملف</button>
            <button type="button" className="add-button" onClick={() => setSelected(null)}>إغلاق المعاينة</button>
          </div>
        </div>
        {selected.extension === "pdf" && <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0" }}>
          <label htmlFor="pdf-page">الصفحة الحالية:</label>
          <select id="pdf-page" value={currentPage} onChange={(event) => setCurrentPage(Number(event.target.value))}
            style={{ minHeight: 38, border: "1px solid #cbd6e2", borderRadius: 8, padding: "4px 10px" }}>
            {selected.pages.map((_page, index) => <option key={index} value={index + 1}>صفحة {index + 1}</option>)}
          </select>
          <span className="muted">من {selected.pages.length}</span>
        </div>}
        <div style={{ border: "1px solid #d7dee8", borderRadius: 10, overflow: "hidden", background: "#f3f5f7" }}>
          {selected.extension === "pdf" ? <iframe title="معاينة ملف PDF" src={previewUrl + "#page=" + currentPage + "&toolbar=1"}
            style={{ width: "100%", height: " min(75vh, 850px)", minHeight: 560, border: 0 }} /> :
            <pre style={{ whiteSpace: "pre-wrap", overflow: "auto", maxHeight: 600, padding: 18, direction: "auto", background: "white" }}>{pageText || "لا يوجد نص قابل للعرض."}</pre>}
        </div>
        <div style={{ marginTop: 18 }}>
          <h3>الأسماء وتواريخ الميلاد في الصفحة الحالية</h3>
          {extractedPeople.length ? <div className="folder-results">{extractedPeople.map((person, index) => (
            <div className="folder-result" key={index} dir="ltr" style={{ textAlign: "left", fontWeight: 700 }}>
              {person.name} - {person.dob}
            </div>
          ))}</div> : <p className="empty-exclusions">لم يتم العثور على اسم وتاريخ ميلاد بصيغة معروفة في نص هذه الصفحة. قد يحتاج المستند إلى مراجعة يدوية أو OCR إذا كان ممسوحاً ضوئياً.</p>}
          <p className="saved-hint">يتم استخراج البيانات من النص الموجود في الصفحة المحددة فقط. راجع النتيجة قبل اعتمادها.</p>
        </div>
      </section>}

      {warnings.length > 0 && <section className="panel"><h2>ملفات تعذرت قراءتها</h2>
        <ul className="steps">{warnings.map((path) => <li key={path} dir="ltr">{path}</li>)}</ul></section>}
      <p className="foot"><a href="/" style={{ color: "#1769aa" }}>العودة إلى أدوات الفندق</a></p>
    </div>
  );
}
